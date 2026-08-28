import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConversationRole, WorkspaceStatus, type Conversation, type Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentClient } from './agent-client';

export type ChatMessage = {
  id: string;
  userId: string;
  threadId: string;
  role: 'student' | 'tutor';
  text: string;
  createdAt: string;
};

@Injectable()
export class ChatService {
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

    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace?.labId || workspace.status !== WorkspaceStatus.RUNNING) {
      return this.respondWithFallback(userId, enrollment.id, studentRow, '请先启动虚拟机后再提问。');
    }

    const progress = await this.prisma.progress.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!progress?.currentLessonId) {
      return this.respondWithFallback(userId, enrollment.id, studentRow, '还没有开始学习课程内容，请先进入第一课时。');
    }

    // Agent 集成部分：第二轮补上。
    return this.respondWithFallback(userId, enrollment.id, studentRow, '助教暂时不可用，请稍后再试。');
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
