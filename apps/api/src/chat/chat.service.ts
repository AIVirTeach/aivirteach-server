import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConversationRole, WorkspaceStatus, type Conversation, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AgentClient, DiagnoseResponseSchema, type DiagnoseRequestBody } from './agent-client';

export type ChatMessage = {
  id: string;
  userId: string;
  threadId: string;
  role: 'student' | 'tutor';
  text: string;
  createdAt: string;
};

export type ChatStreamEvent =
  | { type: 'progress'; event: string; data: Record<string, unknown> }
  | { type: 'complete'; studentMessage: ChatMessage; tutorMessage: ChatMessage };

const ResultFrameSchema = z.object({ response: DiagnoseResponseSchema });

type DiagnoseInputs = Pick<DiagnoseRequestBody, 'lab_id' | 'course' | 'current_step'>;
type ResolvedDiagnoseRequest = { ok: true; inputs: DiagnoseInputs } | { ok: false; fallbackMessage: string };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentClient: AgentClient,
  ) {}

  async getMessages(userId: string, enrollmentId: string): Promise<ChatMessage[]> {
    await this.requireOwnedEnrollment(userId, enrollmentId);
    const rows = await this.prisma.conversation.findMany({
      where: { enrollmentId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toChatMessage(userId, row));
  }

  async sendMessage(
    userId: string,
    enrollmentId: string,
    text: string,
  ): Promise<{ studentMessage: ChatMessage; tutorMessage: ChatMessage }> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);

    const studentRow = await this.prisma.conversation.create({
      data: { enrollmentId: enrollment.id, threadId: enrollment.id, role: ConversationRole.USER, content: text },
    });

    const resolved = await this.resolveDiagnoseRequest(enrollment.id);
    if (!resolved.ok) {
      return this.respondWithFallback(userId, enrollment.id, studentRow, resolved.fallbackMessage);
    }

    let response: Awaited<ReturnType<AgentClient['diagnose']>>;
    try {
      response = await this.agentClient.diagnose({
        request_id: randomUUID(),
        question: text,
        ...resolved.inputs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.error(`enrollmentId=${enrollment.id} Agent 诊断调用失败`, message);
      return this.respondWithFallback(userId, enrollment.id, studentRow, '助教暂时不可用，请稍后再试。');
    }

    const tutorRow = await this.prisma.conversation.create({
      data: {
        enrollmentId: enrollment.id,
        threadId: enrollment.id,
        role: ConversationRole.ASSISTANT,
        content: response.answer,
        contextRef: response as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      studentMessage: this.toChatMessage(userId, studentRow),
      tutorMessage: this.toChatMessage(userId, tutorRow),
    };
  }

  async *streamMessage(userId: string, enrollmentId: string, text: string): AsyncGenerator<ChatStreamEvent> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);

    const studentRow = await this.prisma.conversation.create({
      data: { enrollmentId: enrollment.id, threadId: enrollment.id, role: ConversationRole.USER, content: text },
    });

    const resolved = await this.resolveDiagnoseRequest(enrollment.id);
    if (!resolved.ok) {
      yield {
        type: 'complete',
        ...(await this.respondWithFallback(userId, enrollment.id, studentRow, resolved.fallbackMessage)),
      };
      return;
    }

    // result 帧落库前只转发 progress——result 本身不当 progress 转发，落库成功后
    // 才发一个 complete 事件；一个 JSON.parse/schema 校验失败就直接走下面的兜底，
    // 不把半成品结果透传给 client（跟 sendMessage() 的"聊天接口不返回 5xx"约束一致）。
    let response: z.infer<typeof DiagnoseResponseSchema> | null = null;
    try {
      for await (const frame of this.agentClient.diagnoseStream({
        request_id: randomUUID(),
        question: text,
        ...resolved.inputs,
      })) {
        const data = JSON.parse(frame.data) as Record<string, unknown>;
        if (frame.event === 'result') {
          const parsed = ResultFrameSchema.safeParse(data);
          if (parsed.success) response = parsed.data.response;
          continue;
        }
        yield { type: 'progress', event: frame.event, data };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.error(`enrollmentId=${enrollment.id} Agent 诊断流调用失败`, message);
    }

    if (!response) {
      // 走到这里之前很可能已经转发过 progress 帧（headers 已提交），落兜底消息这个写入
      // 本身再失败就没有更兜底的兜底了——只能记日志后让 generator 正常 return，把 SSE
      // 连接干净收尾，不能让异常直接炸穿到 controller 层。
      try {
        yield {
          type: 'complete',
          ...(await this.respondWithFallback(userId, enrollment.id, studentRow, '助教暂时不可用，请稍后再试。')),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        this.logger.error(`enrollmentId=${enrollment.id} 落兜底消息失败`, message);
      }
      return;
    }

    let tutorRow: Conversation;
    try {
      tutorRow = await this.prisma.conversation.create({
        data: {
          enrollmentId: enrollment.id,
          threadId: enrollment.id,
          role: ConversationRole.ASSISTANT,
          content: response.answer,
          contextRef: response as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // 同上：此时已经转发过 progress 帧，headers 已提交，不能再让这个写入失败以
      // 异常形式冒泡出去——记日志后干净结束这次流。
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.error(`enrollmentId=${enrollment.id} 落 Assistant 消息失败`, message);
      return;
    }

    yield {
      type: 'complete',
      studentMessage: this.toChatMessage(userId, studentRow),
      tutorMessage: this.toChatMessage(userId, tutorRow),
    };
  }

  private async resolveDiagnoseRequest(enrollmentId: string): Promise<ResolvedDiagnoseRequest> {
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId } });
    if (!workspace?.labId || workspace.status !== WorkspaceStatus.RUNNING) {
      return { ok: false, fallbackMessage: '请先启动虚拟机后再提问。' };
    }

    // 聊天本身就是"学生还在用这个 workspace"的活跃信号，顺手刷新 lastSeenAt——不能只靠
    // 客户端独立的 60 秒心跳定时器，否则一次长对话中如果心跳断了，idle-sweep 可能会在
    // 对话中途把 VM 收掉。sendMessage/streamMessage 都走这里，改一处即可覆盖两条路径。
    await this.prisma.workspace.update({ where: { enrollmentId }, data: { lastSeenAt: new Date() } });

    const progress = await this.prisma.progress.findUnique({ where: { enrollmentId } });
    if (!progress?.currentLessonId) {
      return { ok: false, fallbackMessage: '还没有开始学习课程内容，请先进入第一课时。' };
    }

    const context = await this.buildDiagnoseContext(progress.currentLessonId);
    if (!context) {
      return { ok: false, fallbackMessage: '还没有开始学习课程内容，请先进入第一课时。' };
    }

    return { ok: true, inputs: { lab_id: workspace.labId, course: context.course, current_step: context.currentStep } };
  }

  private async buildDiagnoseContext(
    currentLessonId: string,
  ): Promise<{ course: DiagnoseRequestBody['course']; currentStep: DiagnoseRequestBody['current_step'] } | null> {
    const lesson = await this.prisma.courseLesson.findUnique({
      where: { id: currentLessonId },
      include: {
        assessments: true,
        module: {
          include: {
            courseVersion: {
              include: {
                course: true,
                modules: { orderBy: { position: 'asc' }, include: { lessons: { orderBy: { position: 'asc' } } } },
              },
            },
          },
        },
      },
    });
    if (!lesson) return null;

    const flattened = lesson.module.courseVersion.modules.flatMap((courseModule) => courseModule.lessons);
    const sequence = flattened.findIndex((entry) => entry.id === lesson.id) + 1;
    if (sequence === 0) {
      // 理论上不该发生：lesson 本该出现在自己 module 的 lessons 列表里。真出现说明数据有不一致，
      // 跟 Agent 调用失败区分开单独记一条，不然只看兜底消息看不出是这个原因。
      this.logger.warn(`courseLessonId=${lesson.id} 在自己所属 module 的 lessons 列表里找不到自己（数据不一致）`);
    }
    const assessment = lesson.assessments[0] ?? null;

    return {
      course: {
        course_id: lesson.module.courseVersion.course.slug,
        version: lesson.module.courseVersion.version,
        title: lesson.module.courseVersion.course.title,
        summary: lesson.module.courseVersion.course.description,
      },
      currentStep: {
        module_id: lesson.module.id,
        lesson_id: lesson.contentId,
        sequence,
        title: lesson.title,
        instructions: lesson.activityPrompt
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean),
        expected_result: assessment?.expectedResult ?? '',
        success_criteria: assessment?.successCriteria ?? [],
        common_failures: (assessment?.commonFailures ?? []).map((code) => ({ code, symptoms: [] as string[] })),
      },
    };
  }

  private async respondWithFallback(
    userId: string,
    enrollmentId: string,
    studentRow: Conversation,
    message: string,
  ): Promise<{ studentMessage: ChatMessage; tutorMessage: ChatMessage }> {
    const tutorRow = await this.prisma.conversation.create({
      data: { enrollmentId, threadId: enrollmentId, role: ConversationRole.ASSISTANT, content: message },
    });
    return {
      studentMessage: this.toChatMessage(userId, studentRow),
      tutorMessage: this.toChatMessage(userId, tutorRow),
    };
  }

  private toChatMessage(userId: string, row: Conversation): ChatMessage {
    return {
      id: row.id,
      userId,
      threadId: row.threadId,
      role: row.role === ConversationRole.USER ? 'student' : 'tutor',
      text: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async requireOwnedEnrollment(userId: string, enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment || enrollment.userId !== userId) {
      throw new ForbiddenException('无权访问这个 enrollment');
    }
    return enrollment;
  }
}
