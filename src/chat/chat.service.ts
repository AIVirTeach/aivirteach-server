import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConversationRole, type Conversation } from '@prisma/client';
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
