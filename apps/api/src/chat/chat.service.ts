import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConversationRole,
  WorkspaceStatus,
  type Conversation,
  type Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LATEST_PUBLISHED_VERSION } from '../courses/published-version';
import {
  assertCurrentEnrollment,
  StaleEnrollmentError,
} from '../enrollments/assert-current-enrollment';
import { TOKEN_WEIGHTS } from '../token-usage/application/check-token-quota';
import {
  weightedConsumption,
  type TokenWeights,
} from '../token-usage/domain/token-weights';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgentClient,
  DiagnoseResponseSchema,
  type DiagnoseRequestBody,
  type DiagnoseResponseBody,
} from './agent-client';

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
  | {
      type: 'complete';
      studentMessage: ChatMessage;
      tutorMessage: ChatMessage;
    };

const ResultFrameSchema = z.object({ response: DiagnoseResponseSchema });

// Labs 没返回 usage 时返回空对象：三列保持为空（未计量），不能写成 0——否则分不清
// "没计上量"和"真的零消耗"。
function usageColumns(usage: DiagnoseResponseBody['usage']) {
  if (!usage) return {};
  return {
    inputCacheHitTokens: usage.input_cache_hit_tokens,
    inputCacheMissTokens: usage.input_cache_miss_tokens,
    outputTokens: usage.output_tokens,
  };
}

type DiagnoseInputs = Pick<
  DiagnoseRequestBody,
  'lab_id' | 'course' | 'current_step'
>;
type ResolvedDiagnoseRequest =
  { ok: true; inputs: DiagnoseInputs } | { ok: false; fallbackMessage: string };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentClient: AgentClient,
    @Inject(TOKEN_WEIGHTS) private readonly tokenWeights: TokenWeights,
  ) {}

  async getMessages(
    userId: string,
    enrollmentId: string,
  ): Promise<ChatMessage[]> {
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

    const studentRow = await this.createCurrentConversation(
      enrollment.id,
      enrollment.generation,
      {
        enrollmentId: enrollment.id,
        threadId: enrollment.id,
        role: ConversationRole.USER,
        content: text,
      },
    );

    const resolved = await this.resolveDiagnoseRequest(
      enrollment.id,
      enrollment.courseId,
      enrollment.completedAt !== null,
    );
    if (!resolved.ok) {
      return this.respondWithFallback(
        userId,
        enrollment.id,
        enrollment.generation,
        studentRow,
        resolved.fallbackMessage,
      );
    }

    const requestId = randomUUID();
    let response: Awaited<ReturnType<AgentClient['diagnose']>>;
    try {
      response = await this.agentClient.diagnose({
        request_id: requestId,
        question: text,
        ...resolved.inputs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.error(
        `enrollmentId=${enrollment.id} Agent 诊断调用失败`,
        message,
      );
      return this.respondWithFallback(
        userId,
        enrollment.id,
        enrollment.generation,
        studentRow,
        '助教暂时不可用，请稍后再试。',
      );
    }

    const tutorRow = await this.saveAgentReply(
      userId,
      enrollment.id,
      enrollment.generation,
      requestId,
      response,
      {
        enrollmentId: enrollment.id,
        threadId: enrollment.id,
        role: ConversationRole.ASSISTANT,
        content: response.answer,
        contextRef: response as unknown as Prisma.InputJsonValue,
        ...usageColumns(response.usage),
      },
    );

    return {
      studentMessage: this.toChatMessage(userId, studentRow),
      tutorMessage: this.toChatMessage(userId, tutorRow),
    };
  }

  async *streamMessage(
    userId: string,
    enrollmentId: string,
    text: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);

    const studentRow = await this.createCurrentConversation(
      enrollment.id,
      enrollment.generation,
      {
        enrollmentId: enrollment.id,
        threadId: enrollment.id,
        role: ConversationRole.USER,
        content: text,
      },
    );

    const resolved = await this.resolveDiagnoseRequest(
      enrollment.id,
      enrollment.courseId,
      enrollment.completedAt !== null,
    );
    if (!resolved.ok) {
      yield {
        type: 'complete',
        ...(await this.respondWithFallback(
          userId,
          enrollment.id,
          enrollment.generation,
          studentRow,
          resolved.fallbackMessage,
        )),
      };
      return;
    }

    // result 帧落库前只转发 progress——result 本身不当 progress 转发，落库成功后
    // 才发一个 complete 事件；一个 JSON.parse/schema 校验失败就直接走下面的兜底，
    // 不把半成品结果透传给 client（跟 sendMessage() 的"聊天接口不返回 5xx"约束一致）。
    const requestId = randomUUID();
    let response: z.infer<typeof DiagnoseResponseSchema> | null = null;
    try {
      for await (const frame of this.agentClient.diagnoseStream({
        request_id: requestId,
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
      this.logger.error(
        `enrollmentId=${enrollment.id} Agent 诊断流调用失败`,
        message,
      );
    }

    if (!response) {
      // 走到这里之前很可能已经转发过 progress 帧（headers 已提交），落兜底消息这个写入
      // 本身再失败就没有更兜底的兜底了——只能记日志后让 generator 正常 return，把 SSE
      // 连接干净收尾，不能让异常直接炸穿到 controller 层。
      try {
        yield {
          type: 'complete',
          ...(await this.respondWithFallback(
            userId,
            enrollment.id,
            enrollment.generation,
            studentRow,
            '助教暂时不可用，请稍后再试。',
          )),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        this.logger.error(
          `enrollmentId=${enrollment.id} 落兜底消息失败`,
          message,
        );
      }
      return;
    }

    let tutorRow: Conversation;
    try {
      tutorRow = await this.saveAgentReply(
        userId,
        enrollment.id,
        enrollment.generation,
        requestId,
        response,
        {
          enrollmentId: enrollment.id,
          threadId: enrollment.id,
          role: ConversationRole.ASSISTANT,
          content: response.answer,
          contextRef: response as unknown as Prisma.InputJsonValue,
          ...usageColumns(response.usage),
        },
      );
    } catch (error) {
      // 同上：此时已经转发过 progress 帧，headers 已提交，不能再让这个写入失败以
      // 异常形式冒泡出去——记日志后干净结束这次流。
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.error(
        `enrollmentId=${enrollment.id} 落 Assistant 消息失败`,
        message,
      );
      return;
    }

    yield {
      type: 'complete',
      studentMessage: this.toChatMessage(userId, studentRow),
      tutorMessage: this.toChatMessage(userId, tutorRow),
    };
  }

  private async resolveDiagnoseRequest(
    enrollmentId: string,
    courseId: string,
    courseCompleted: boolean,
  ): Promise<ResolvedDiagnoseRequest> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId },
    });
    if (!workspace?.labId || workspace.status !== WorkspaceStatus.RUNNING) {
      return { ok: false, fallbackMessage: '请先启动虚拟机后再提问。' };
    }

    // 聊天本身就是"学生还在用这个 workspace"的活跃信号，顺手刷新 lastSeenAt——不能只靠
    // 客户端独立的 60 秒心跳定时器，否则一次长对话中如果心跳断了，idle-sweep 可能会在
    // 对话中途把 VM 收掉。sendMessage/streamMessage 都走这里，改一处即可覆盖两条路径。
    await this.prisma.workspace.update({
      where: { enrollmentId },
      data: { lastSeenAt: new Date() },
    });

    const progress = await this.prisma.progress.findUnique({
      where: { enrollmentId },
    });
    // 指针为空有两种含义：还没进入任何课时，或已学完整门课（completeLesson 学完最后一课时
    // 置空）。两者都允许提问，上下文只读不写：没开始用第一课，已学完用最后一课。
    const pointer = progress?.currentLessonContentId ?? null;
    const context = await this.buildDiagnoseContext(
      courseId,
      pointer,
      courseCompleted,
    );
    if (!context) {
      this.logger.warn(
        `enrollmentId=${enrollmentId} 课程内容不可用，未调用 Agent（currentLessonContentId=${pointer ?? 'null'}）`,
      );
      return {
        ok: false,
        fallbackMessage: '课程内容暂时不可用，请稍后再试。',
      };
    }

    return {
      ok: true,
      inputs: {
        lab_id: workspace.labId,
        course: context.course,
        current_step: context.currentStep,
      },
    };
  }

  private async buildDiagnoseContext(
    courseId: string,
    currentLessonContentId: string | null,
    courseCompleted: boolean,
  ): Promise<{
    course: DiagnoseRequestBody['course'];
    currentStep: DiagnoseRequestBody['current_step'];
  } | null> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });
    const version = course?.versions[0];
    if (!course || !version) return null;

    const flattened = version.modules.flatMap((courseModule) =>
      courseModule.lessons.map((lesson) => ({ lesson, courseModule })),
    );
    if (!flattened.length) return null;
    const index =
      currentLessonContentId === null
        ? courseCompleted
          ? flattened.length - 1
          : 0
        : flattened.findIndex(
            ({ lesson }) => lesson.contentId === currentLessonContentId,
          );
    if (index < 0) return null;
    const { lesson, courseModule } = flattened[index];
    const sequence = index + 1;
    const lessonWithAssessment = await this.prisma.courseLesson.findFirst({
      where: {
        id: lesson.id,
        moduleId: courseModule.id,
        module: { courseVersionId: version.id, courseVersion: { courseId } },
      },
      select: { assessments: { take: 1 } },
    });
    if (!lessonWithAssessment) return null;
    const assessment = lessonWithAssessment.assessments[0] ?? null;

    return {
      course: {
        course_id: course.slug,
        version: version.version,
        title: course.title,
        summary: course.description,
      },
      currentStep: {
        module_id: courseModule.id,
        lesson_id: lesson.contentId,
        sequence,
        title: lesson.title,
        instructions: lesson.activityPrompt
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean),
        expected_result: assessment?.expectedResult ?? '',
        success_criteria: assessment?.successCriteria ?? [],
        common_failures: (assessment?.commonFailures ?? []).map((code) => ({
          code,
          symptoms: [] as string[],
        })),
      },
    };
  }

  private async respondWithFallback(
    userId: string,
    enrollmentId: string,
    generation: number,
    studentRow: Conversation,
    message: string,
  ): Promise<{ studentMessage: ChatMessage; tutorMessage: ChatMessage }> {
    const tutorRow = await this.createCurrentConversation(
      enrollmentId,
      generation,
      {
        enrollmentId,
        threadId: enrollmentId,
        role: ConversationRole.ASSISTANT,
        content: message,
      },
    );
    return {
      studentMessage: this.toChatMessage(userId, studentRow),
      tutorMessage: this.toChatMessage(userId, tutorRow),
    };
  }

  private createCurrentConversation(
    enrollmentId: string,
    generation: number,
    data: Prisma.ConversationUncheckedCreateInput,
  ): Promise<Conversation> {
    return this.prisma.$transaction(async (tx) => {
      await assertCurrentEnrollment(tx, enrollmentId, generation);
      return tx.conversation.create({ data });
    });
  }

  private async saveAgentReply(
    userId: string,
    enrollmentId: string,
    generation: number,
    requestId: string,
    response: DiagnoseResponseBody,
    data: Prisma.ConversationUncheckedCreateInput,
  ): Promise<Conversation> {
    try {
      return await this.createCurrentConversation(
        enrollmentId,
        generation,
        data,
      );
    } catch (error) {
      if (error instanceof StaleEnrollmentError && response.usage) {
        // Chat history belongs to an enrollment generation; usage belongs to the
        // user's quota even when the response arrives after that generation ends.
        const consumed = weightedConsumption(
          {
            inputCacheHitTokens: response.usage.input_cache_hit_tokens,
            inputCacheMissTokens: response.usage.input_cache_miss_tokens,
            outputTokens: response.usage.output_tokens,
          },
          this.tokenWeights,
        );
        if (consumed > 0) {
          await this.prisma.quotaLedger.upsert({
            where: { id: `stale-agent-${requestId}` },
            update: {},
            create: {
              id: `stale-agent-${requestId}`,
              userId,
              tokensDelta: -consumed,
            },
          });
        }
      }
      throw error;
    }
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
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment || enrollment.userId !== userId) {
      throw new ForbiddenException('无权访问这个 enrollment');
    }
    return enrollment;
  }
}
