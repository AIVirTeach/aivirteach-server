import { ForbiddenException, Logger } from '@nestjs/common';
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

const LESSON = {
  id: 'lesson_1',
  contentId: 'verify-virtual-machine',
  title: '验证虚拟机',
  activityPrompt: '打开终端\n运行 docker --version\n确认版本号打印出来',
  assessments: [
    { expectedResult: '看到 docker 版本号', successCriteria: ['命令成功执行'], commonFailures: ['docker 服务未启动'] },
  ],
  module: {
    id: 'module_1',
    courseVersion: {
      version: 1,
      course: { slug: 'linux-basics', title: 'Linux 基础', description: '入门课程' },
      modules: [
        { position: 1, lessons: [{ id: 'lesson_0', position: 1 }, { id: 'lesson_1', position: 2 }] },
      ],
    },
  },
};

describe('ChatService.sendMessage — 调用 Agent', () => {
  function setupReadyWorkspace(prisma: ReturnType<typeof buildPrisma>) {
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({ labId: 'lab_1', status: WorkspaceStatus.RUNNING });
    prisma.progress.findUnique.mockResolvedValue({ currentLessonId: 'lesson_1' });
    prisma.courseLesson.findUnique.mockResolvedValue(LESSON);
  }

  it('成功响应：落 ASSISTANT 消息，content=answer，contextRef=完整响应，payload 字段映射正确', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: 'docker 装不上' }));
    const diagnoseResponse = {
      request_id: 'req_1',
      status: 'completed',
      answer: '试试重启 docker 服务',
      diagnosis: {},
      course_alignment: {},
      evidence: [],
      suggested_actions: [],
      limitations: [],
      tool_trace: [],
    };
    agentClient.diagnose.mockResolvedValue(diagnoseResponse);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: diagnoseResponse.answer,
        contextRef: diagnoseResponse,
      }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', 'docker 装不上');

    expect(result.tutorMessage.text).toBe('试试重启 docker 服务');
    expect(agentClient.diagnose).toHaveBeenCalledWith(
      expect.objectContaining({
        lab_id: 'lab_1',
        question: 'docker 装不上',
        course: { course_id: 'linux-basics', version: 1, title: 'Linux 基础', summary: '入门课程' },
        current_step: {
          module_id: 'module_1',
          lesson_id: 'verify-virtual-machine',
          sequence: 2,
          title: '验证虚拟机',
          instructions: ['打开终端', '运行 docker --version', '确认版本号打印出来'],
          expected_result: '看到 docker 版本号',
          success_criteria: ['命令成功执行'],
          common_failures: [{ code: 'docker 服务未启动', symptoms: [] }],
        },
      }),
    );
    expect(prisma.conversation.create).toHaveBeenLastCalledWith({
      data: {
        enrollmentId: 'enr_1',
        threadId: 'enr_1',
        role: ConversationRole.ASSISTANT,
        content: '试试重启 docker 服务',
        contextRef: diagnoseResponse,
      },
    });
  });

  it('status: "partial" 也走成功路径，不当错误处理', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: '？' }));
    const diagnoseResponse = {
      request_id: 'req_2',
      status: 'partial',
      answer: '工具调用失败，但根据已知信息：...',
      diagnosis: {},
      course_alignment: {},
      evidence: [],
      suggested_actions: [],
      limitations: ['GATEWAY_UNAVAILABLE'],
      tool_trace: [],
    };
    agentClient.diagnose.mockResolvedValue(diagnoseResponse);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: diagnoseResponse.answer,
        contextRef: diagnoseResponse,
      }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', '？');

    expect(result.tutorMessage.text).toBe(diagnoseResponse.answer);
  });

  it('Agent 调用失败时落兜底消息，不抛错', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: '？' }));
    agentClient.diagnose.mockRejectedValue(new Error('fetch failed'));
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'tutor_1', role: ConversationRole.ASSISTANT, content: '助教暂时不可用，请稍后再试。' }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', '？');

    expect(result.tutorMessage.text).toBe('助教暂时不可用，请稍后再试。');
  });

  it('Agent 调用失败时把详细错误记到 server 日志，不能只落一条兜底消息就悄悄吞掉', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(conversationRow({ id: 'student_1', content: '？' }));
    agentClient.diagnose.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'tutor_1', role: ConversationRole.ASSISTANT, content: '助教暂时不可用，请稍后再试。' }),
    );

    await service.sendMessage('user_1', 'enr_1', '？');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('enr_1'), expect.stringContaining('fetch failed: ECONNREFUSED'));
    errorSpy.mockRestore();
  });
});
