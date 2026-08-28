import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentClient } from './agent-client';
import { ChatService } from './chat.service';

function buildPrisma() {
  return {
    enrollment: { findUnique: jest.fn() },
    conversation: { create: jest.fn(), findMany: jest.fn() },
    workspace: { findUnique: jest.fn() },
    progress: { findUnique: jest.fn() },
    courseLesson: { findUnique: jest.fn() },
  };
}

async function buildService(
  overrides: { prisma?: ReturnType<typeof buildPrisma>; agentClient?: any } = {},
) {
  const prisma = overrides.prisma ?? buildPrisma();
  const agentClient = overrides.agentClient ?? { diagnose: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatService,
      { provide: PrismaService, useValue: prisma },
      { provide: AgentClient, useValue: agentClient },
    ],
  }).compile();
  return { service: moduleRef.get(ChatService), prisma, agentClient };
}

const ENROLLMENT = { id: 'enr_1', userId: 'user_1' };

function conversationRow(overrides: Partial<{
  id: string;
  role: ConversationRole;
  content: string;
  threadId: string;
  contextRef: unknown;
  createdAt: Date;
}>) {
  return {
    id: 'conv_1',
    enrollmentId: 'enr_1',
    threadId: 'enr_1',
    role: ConversationRole.USER,
    content: 'hi',
    contextRef: null,
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ChatService.getMessages', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.getMessages('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('按时间正序返回消息，role/text 映射成 client 期望的形状', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.findMany.mockResolvedValue([
      conversationRow({ id: 'conv_1', role: ConversationRole.USER, content: '你好' }),
      conversationRow({ id: 'conv_2', role: ConversationRole.ASSISTANT, content: '你好，有什么可以帮你' }),
    ]);

    const result = await service.getMessages('user_1', 'enr_1');

    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([
      { id: 'conv_1', userId: 'user_1', threadId: 'enr_1', role: 'student', text: '你好', createdAt: '2026-08-28T00:00:00.000Z' },
      { id: 'conv_2', userId: 'user_1', threadId: 'enr_1', role: 'tutor', text: '你好，有什么可以帮你', createdAt: '2026-08-28T00:00:00.000Z' },
    ]);
  });
});

import { WorkspaceStatus } from '@prisma/client';

describe('ChatService.sendMessage — 兜底路径（不调用 Agent）', () => {
  it('enrollment 不属于当前用户时拒绝，且不写入任何 Conversation', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });

    await expect(service.sendMessage('user_1', 'enr_1', '你好')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('没有 Workspace 记录时落兜底消息，不调用 Agent', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: '你好' }));
    prisma.workspace.findUnique.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'tutor_1', role: ConversationRole.ASSISTANT, content: '请先启动虚拟机后再提问。' }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', '你好');

    expect(result.tutorMessage.text).toBe('请先启动虚拟机后再提问。');
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });

  it('Workspace 状态不是 RUNNING 时落兜底消息', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: '你好' }));
    prisma.workspace.findUnique.mockResolvedValue({ labId: 'lab_1', status: WorkspaceStatus.CREATING });
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'tutor_1', role: ConversationRole.ASSISTANT, content: '请先启动虚拟机后再提问。' }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', '你好');

    expect(result.tutorMessage.text).toBe('请先启动虚拟机后再提问。');
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });

  it('还没有 Progress（没上过任何课时）时落兜底消息', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: '你好' }));
    prisma.workspace.findUnique.mockResolvedValue({ labId: 'lab_1', status: WorkspaceStatus.RUNNING });
    prisma.progress.findUnique.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'tutor_1', role: ConversationRole.ASSISTANT, content: '还没有开始学习课程内容，请先进入第一课时。' }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', '你好');

    expect(result.tutorMessage.text).toBe('还没有开始学习课程内容，请先进入第一课时。');
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });
});
