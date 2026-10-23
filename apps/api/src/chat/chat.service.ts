import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  ConversationRole,
  WorkspaceStatus,
  type Conversation,
  type Prisma,
} from '@prisma/client';
import type { SendChatMessageInput } from './chat.schemas';
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

type AcceptedDiagnoseContext = Pick<
  DiagnoseRequestBody,
  'course' | 'current_step'
>;
type DiagnoseInputs = AcceptedDiagnoseContext &
  Pick<DiagnoseRequestBody, 'lab_id'>;
type ResolvedDiagnoseRequest =
  { ok: true; inputs: DiagnoseInputs } | { ok: false; fallbackMessage: string };

export type AcceptedChat = {
  userId: string;
  enrollmentId: string;
  command: SendChatMessageInput;
  studentRow: Conversation;
  resolved: ResolvedDiagnoseRequest;
};

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
    generation: number,
  ): Promise<ChatMessage[]> {
    await this.requireOwnedEnrollment(userId, enrollmentId);
    const rows = await this.prisma.$transaction(async (tx) => {
      await assertCurrentEnrollment(tx, enrollmentId, generation);
      return tx.conversation.findMany({
        where: { enrollmentId, generation },
        orderBy: { createdAt: 'asc' },
      });
    });
    return rows.map((row) => this.toChatMessage(userId, row));
  }

  async sendMessage(
    userId: string,
    enrollmentId: string,
    command: SendChatMessageInput,
  ): Promise<{ studentMessage: ChatMessage; tutorMessage: ChatMessage }> {
    const accepted = await this.prepareMessage(userId, enrollmentId, command);
    const { studentRow, resolved } = accepted;
    const enrollment = {
      id: enrollmentId,
      generation: command.context.generation,
    };
    const { text, requestId } = command;
    if (!resolved.ok) {
      return this.respondWithFallback(
        userId,
        enrollment.id,
        enrollment.generation,
        studentRow,
        resolved.fallbackMessage,
      );
    }

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
        ...this.contextColumns(studentRow),
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
    command: SendChatMessageInput,
  ): AsyncGenerator<ChatStreamEvent> {
    yield* this.streamPrepared(
      await this.prepareMessage(userId, enrollmentId, command),
    );
  }

  async *streamPrepared(
    accepted: AcceptedChat,
  ): AsyncGenerator<ChatStreamEvent> {
    const { userId, enrollmentId, command, studentRow, resolved } = accepted;
    const enrollment = {
      id: enrollmentId,
      generation: command.context.generation,
    };
    const { text, requestId } = command;
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
    let response: z.infer<typeof DiagnoseResponseSchema> | null = null;
    let mayForwardProgress = true;
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
        if (mayForwardProgress) {
          try {
            await this.prisma.$transaction((tx) =>
              assertCurrentEnrollment(
                tx,
                enrollmentId,
                command.context.generation,
              ),
            );
          } catch (error) {
            if (!(error instanceof StaleEnrollmentError)) throw error;
            mayForwardProgress = false;
          }
        }
        if (!mayForwardProgress) continue;
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
          ...this.contextColumns(studentRow),
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

  async prepareMessage(
    userId: string,
    enrollmentId: string,
    command: SendChatMessageInput,
  ): Promise<AcceptedChat> {
    const owned = await this.requireOwnedEnrollment(userId, enrollmentId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Course" WHERE id = ${owned.courseId} FOR SHARE`;
      await assertCurrentEnrollment(
        tx,
        enrollmentId,
        command.context.generation,
      );
      const duplicate = await tx.conversation.findFirst({
        where: {
          enrollmentId,
          generation: command.context.generation,
          requestId: command.requestId,
          role: ConversationRole.USER,
        },
      });
      if (duplicate)
        throw new ConflictException({
          code: 'chat_request_exists',
          message: '这次提问已提交，请查看对话记录',
        });
      const context = await this.buildDiagnoseContext(
        tx,
        owned.courseId,
        command.context,
      );
      const workspace = await tx.workspace.findUnique({
        where: { enrollmentId },
      });
      let resolved: ResolvedDiagnoseRequest;
      if (!workspace?.labId || workspace.status !== WorkspaceStatus.RUNNING) {
        resolved = { ok: false, fallbackMessage: '请先启动虚拟机后再提问。' };
      } else {
        await tx.workspace.update({
          where: { enrollmentId },
          data: { lastSeenAt: new Date() },
        });
        resolved = {
          ok: true,
          inputs: { lab_id: workspace.labId, ...context },
        };
      }
      const studentRow = await tx.conversation.create({
        data: {
          enrollmentId,
          threadId: enrollmentId,
          role: ConversationRole.USER,
          content: command.text,
          requestId: command.requestId,
          generation: command.context.generation,
          courseVersionId: command.context.courseVersionId,
          lessonContentId: command.context.lessonId,
          acceptedContext: {
            course: context.course,
            current_step: context.current_step,
          },
        },
      });
      return { userId, enrollmentId, command, studentRow, resolved };
    });
  }

  private async buildDiagnoseContext(
    tx: Prisma.TransactionClient,
    courseId: string,
    reference: SendChatMessageInput['context'],
  ): Promise<AcceptedDiagnoseContext> {
    const course = await tx.course.findUnique({
      where: { id: courseId },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });
    const version = course?.versions[0];
    if (
      !course?.published ||
      !version ||
      version.id !== reference.courseVersionId
    )
      throw new ConflictException({
        code: 'course_version_changed',
        message: '课程已更新，请刷新后重试',
      });

    const flattened = version.modules.flatMap((courseModule) =>
      courseModule.lessons.map((lesson) => ({ lesson, courseModule })),
    );
    const index = flattened.findIndex(
      ({ lesson }) => lesson.contentId === reference.lessonId,
    );
    if (
      index < 0 ||
      flattened.filter(({ lesson }) => lesson.contentId === reference.lessonId)
        .length !== 1
    )
      throw new NotFoundException({
        code: 'lesson_not_found',
        message: '找不到此版本的唯一课时',
      });
    const { lesson, courseModule } = flattened[index];
    const sequence = index + 1;
    const lessonWithAssessment = await tx.courseLesson.findFirst({
      where: {
        id: lesson.id,
        moduleId: courseModule.id,
        module: { courseVersionId: version.id, courseVersion: { courseId } },
      },
      select: { assessments: { take: 1 } },
    });
    if (!lessonWithAssessment) throw new NotFoundException('课时内容不可用');
    const assessment = lessonWithAssessment.assessments[0] ?? null;

    return {
      course: {
        course_id: course.slug,
        version: version.version,
        title: course.title,
        summary: course.description,
      },
      current_step: {
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

  private contextColumns(row: Conversation) {
    return {
      requestId: row.requestId,
      generation: row.generation,
      courseVersionId: row.courseVersionId,
      lessonContentId: row.lessonContentId,
      ...(row.acceptedContext == null
        ? {}
        : { acceptedContext: row.acceptedContext as Prisma.InputJsonValue }),
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
        ...this.contextColumns(studentRow),
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
            where: {
              id: `stale-agent-${enrollmentId}-${generation}-${requestId}`,
            },
            update: {},
            create: {
              id: `stale-agent-${enrollmentId}-${generation}-${requestId}`,
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
