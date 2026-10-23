import { ForbiddenException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TOKEN_WEIGHTS } from '../token-usage/application/check-token-quota';
import { LATEST_PUBLISHED_VERSION } from '../courses/published-version';
import { AgentClient } from './agent-client';
import { ChatService } from './chat.service';
import type { SendChatMessageInput } from './chat.schemas';

function buildPrisma() {
  return {
    enrollment: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    conversation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    quotaLedger: { upsert: jest.fn().mockResolvedValue({}) },
    workspace: { findUnique: jest.fn(), update: jest.fn() },
    progress: { findUnique: jest.fn() },
    course: { findUnique: jest.fn() },
    courseLesson: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
}

async function buildService(
  overrides: {
    prisma?: ReturnType<typeof buildPrisma>;
    agentClient?: any;
  } = {},
) {
  const prisma = overrides.prisma ?? buildPrisma();
  prisma.course.findUnique.mockResolvedValue(PUBLISHED_COURSE);
  prisma.courseLesson.findFirst.mockResolvedValue({
    assessments: LESSON.assessments,
  });
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  const agentClient = overrides.agentClient ?? {
    diagnose: jest.fn(),
    diagnoseStream: jest.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatService,
      { provide: PrismaService, useValue: prisma },
      { provide: AgentClient, useValue: agentClient },
      {
        provide: TOKEN_WEIGHTS,
        useValue: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 },
      },
    ],
  }).compile();
  return { service: moduleRef.get(ChatService), prisma, agentClient };
}

let requestSequence = 0;
function ask(
  text: string,
  lessonId = 'verify-virtual-machine',
): SendChatMessageInput {
  requestSequence += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestSequence).padStart(12, '0')}`,
    text,
    context: { courseVersionId: 'version_2', lessonId, generation: 0 },
  };
}

const ENROLLMENT = {
  id: 'enr_1',
  userId: 'user_1',
  courseId: 'course_1',
  completedAt: null,
  active: true,
  generation: 0,
};

function conversationRow(
  overrides: Partial<{
    id: string;
    role: ConversationRole;
    content: string;
    threadId: string;
    contextRef: unknown;
    createdAt: Date;
  }>,
) {
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
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(
      service.getMessages('user_1', 'enr_1', 0),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('按时间正序返回消息，role/text 映射成 client 期望的形状', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.findMany.mockResolvedValue([
      conversationRow({
        id: 'conv_1',
        role: ConversationRole.USER,
        content: '你好',
      }),
      conversationRow({
        id: 'conv_2',
        role: ConversationRole.ASSISTANT,
        content: '你好，有什么可以帮你',
      }),
    ]);

    const result = await service.getMessages('user_1', 'enr_1', 0);

    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1', generation: 0 },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([
      {
        id: 'conv_1',
        userId: 'user_1',
        threadId: 'enr_1',
        role: 'student',
        text: '你好',
        createdAt: '2026-08-28T00:00:00.000Z',
      },
      {
        id: 'conv_2',
        userId: 'user_1',
        threadId: 'enr_1',
        role: 'tutor',
        text: '你好，有什么可以帮你',
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]);
  });

  it('旧代 history 在 restart 后拒绝，且不查询对话', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.enrollment.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.getMessages('user_1', 'enr_1', 0)).rejects.toThrow();
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });
});

import { WorkspaceStatus } from '@prisma/client';

describe('ChatService.sendMessage — 兜底路径（不调用 Agent）', () => {
  it('enrollment 不属于当前用户时拒绝，且不写入任何 Conversation', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });

    await expect(
      service.sendMessage('user_1', 'enr_1', ask('你好')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('没有 Workspace 记录时落兜底消息，不调用 Agent', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '你好' }),
    );
    prisma.workspace.findUnique.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '请先启动虚拟机后再提问。',
      }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', ask('你好'));

    expect(result.tutorMessage.text).toBe('请先启动虚拟机后再提问。');
    expect(agentClient.diagnose).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('Workspace 状态不是 RUNNING 时落兜底消息', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '你好' }),
    );
    prisma.workspace.findUnique.mockResolvedValue({
      labId: 'lab_1',
      status: WorkspaceStatus.CREATING,
    });
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '请先启动虚拟机后再提问。',
      }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', ask('你好'));

    expect(result.tutorMessage.text).toBe('请先启动虚拟机后再提问。');
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });
});

const LESSON = {
  id: 'lesson_1',
  contentId: 'verify-virtual-machine',
  title: '验证虚拟机',
  activityPrompt: '打开终端\n运行 docker --version\n确认版本号打印出来',
  assessments: [
    {
      expectedResult: '看到 docker 版本号',
      successCriteria: ['命令成功执行'],
      commonFailures: ['docker 服务未启动'],
    },
  ],
  module: {
    id: 'module_1',
    courseVersion: {
      version: 1,
      course: {
        slug: 'linux-basics',
        title: 'Linux 基础',
        description: '入门课程',
      },
      modules: [
        {
          position: 1,
          lessons: [
            { id: 'lesson_0', position: 1 },
            { id: 'lesson_1', position: 2 },
          ],
        },
      ],
    },
  },
};

const PUBLISHED_COURSE = {
  published: true,
  slug: 'linux-basics',
  title: 'Linux 基础',
  description: '入门课程',
  versions: [
    {
      id: 'version_2',
      version: 2,
      modules: [
        {
          id: 'module_1',
          position: 1,
          lessons: [
            {
              id: 'lesson_previous',
              contentId: 'previous-lesson',
              position: 1,
              title: '前一课',
              activityPrompt: '',
            },
            {
              id: 'lesson_target',
              contentId: 'verify-virtual-machine',
              position: 2,
              title: '验证虚拟机',
              activityPrompt: LESSON.activityPrompt,
            },
          ],
        },
      ],
    },
  ],
};

describe('ChatService.sendMessage — 调用 Agent', () => {
  it('兜底回复晚于 restart 时不重新写入旧聊天记录', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1' }),
    );
    prisma.workspace.findUnique.mockResolvedValue(null);
    prisma.enrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      service.sendMessage('user_1', 'enr_1', ask('你好')),
    ).rejects.toThrow();
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });

  it('Agent 回复晚于 restart 时不重新写入旧聊天记录', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1' }),
    );
    prisma.enrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    agentClient.diagnose.mockResolvedValue({
      answer: '迟到的回复',
      usage: {
        input_cache_hit_tokens: 10,
        input_cache_miss_tokens: 20,
        output_tokens: 5,
      },
    });

    await expect(
      service.sendMessage('user_1', 'enr_1', ask('你好')),
    ).rejects.toThrow();
    expect(agentClient.diagnose).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(prisma.quotaLedger.upsert).toHaveBeenCalledWith({
      where: { id: expect.stringMatching(/^stale-agent-/) },
      update: {},
      create: expect.objectContaining({ userId: 'user_1', tokensDelta: -41 }),
    });
    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr_1', generation: 0, active: true },
      data: { active: true },
    });
  });

  it('同一 requestId 在不同 enrollment 的迟到回复分别结算一次', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.enrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.conversation.create.mockResolvedValue(
      conversationRow({ id: 'student' }),
    );
    agentClient.diagnose.mockResolvedValue({
      answer: 'late',
      usage: {
        input_cache_hit_tokens: 10,
        input_cache_miss_tokens: 20,
        output_tokens: 5,
      },
    });
    const command: SendChatMessageInput = {
      requestId: '00000000-0000-4000-8000-000000000099',
      text: 'same uuid',
      context: {
        courseVersionId: 'version_2',
        lessonId: 'verify-virtual-machine',
        generation: 0,
      },
    };

    await expect(
      service.sendMessage('user_1', 'enr_1', command),
    ).rejects.toThrow();
    await expect(
      service.sendMessage('user_1', 'enr_2', command),
    ).rejects.toThrow();

    expect(prisma.quotaLedger.upsert).toHaveBeenCalledTimes(2);
    expect(
      prisma.quotaLedger.upsert.mock.calls.map(([input]) => input.where.id),
    ).toEqual([
      'stale-agent-enr_1-0-00000000-0000-4000-8000-000000000099',
      'stale-agent-enr_2-0-00000000-0000-4000-8000-000000000099',
    ]);
  });
  function setupReadyWorkspace(prisma: ReturnType<typeof buildPrisma>) {
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      labId: 'lab_1',
      status: WorkspaceStatus.RUNNING,
    });
    prisma.progress.findUnique.mockResolvedValue({
      currentLessonContentId: 'verify-virtual-machine',
    });
    prisma.course.findUnique.mockResolvedValue(PUBLISHED_COURSE);
    prisma.courseLesson.findFirst.mockResolvedValue({
      assessments: LESSON.assessments,
    });
  }

  it('成功响应：落 ASSISTANT 消息，content=answer，contextRef=完整响应，payload 字段映射正确', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: 'docker 装不上' }),
    );
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

    const before = Date.now();
    const result = await service.sendMessage(
      'user_1',
      'enr_1',
      ask('docker 装不上'),
    );
    const after = Date.now();

    // 聊天本身就是"学生还在用这个 workspace"的活跃信号，不能只靠客户端独立的 60 秒心跳
    // 定时器——否则一次长对话中如果心跳意外断了，idle-sweep 可能会在对话中途把 VM 收掉。
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1' },
      data: { lastSeenAt: expect.any(Date) },
    });
    const touchedAt = prisma.workspace.update.mock.calls[0][0].data
      .lastSeenAt as Date;
    expect(touchedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(touchedAt.getTime()).toBeLessThanOrEqual(after);

    expect(result.tutorMessage.text).toBe('试试重启 docker 服务');
    expect(agentClient.diagnose).toHaveBeenCalledWith(
      expect.objectContaining({
        lab_id: 'lab_1',
        question: 'docker 装不上',
        course: {
          course_id: 'linux-basics',
          version: 2,
          title: 'Linux 基础',
          summary: '入门课程',
        },
        current_step: {
          module_id: 'module_1',
          lesson_id: 'verify-virtual-machine',
          sequence: 2,
          title: '验证虚拟机',
          instructions: [
            '打开终端',
            '运行 docker --version',
            '确认版本号打印出来',
          ],
          expected_result: '看到 docker 版本号',
          success_criteria: ['命令成功执行'],
          common_failures: [{ code: 'docker 服务未启动', symptoms: [] }],
        },
      }),
    );
    expect(prisma.course.findUnique).toHaveBeenCalledWith({
      where: { id: 'course_1' },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });
    expect(prisma.courseLesson.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'lesson_target',
        moduleId: 'module_1',
        module: {
          courseVersionId: 'version_2',
          courseVersion: { courseId: 'course_1' },
        },
      },
      select: { assessments: { take: 1 } },
    });
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
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '？' }),
    );
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

    const result = await service.sendMessage('user_1', 'enr_1', ask('？'));

    expect(result.tutorMessage.text).toBe(diagnoseResponse.answer);
  });

  it('Agent 调用失败时落兜底消息，不抛错', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '？' }),
    );
    agentClient.diagnose.mockRejectedValue(new Error('fetch failed'));
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '助教暂时不可用，请稍后再试。',
      }),
    );

    const result = await service.sendMessage('user_1', 'enr_1', ask('？'));

    expect(result.tutorMessage.text).toBe('助教暂时不可用，请稍后再试。');
  });

  it('Agent 调用失败时把详细错误记到 server 日志，不能只落一条兜底消息就悄悄吞掉', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '？' }),
    );
    agentClient.diagnose.mockRejectedValue(
      new Error('fetch failed: ECONNREFUSED'),
    );
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '助教暂时不可用，请稍后再试。',
      }),
    );

    await service.sendMessage('user_1', 'enr_1', ask('？'));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('enr_1'),
      expect.stringContaining('fetch failed: ECONNREFUSED'),
    );
    errorSpy.mockRestore();
  });

  it.each([
    ['没有 Progress 记录', null],
    ['Progress 指针为 null', { currentLessonContentId: null }],
  ])('%s 时仍以请求携带的已加载课时作为上下文', async (_label, progress) => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.progress.findUnique.mockResolvedValue(progress);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '什么是 docker' }),
    );
    agentClient.diagnose.mockResolvedValue(DIAGNOSE_RESPONSE);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: DIAGNOSE_RESPONSE.answer,
      }),
    );

    const result = await service.sendMessage(
      'user_1',
      'enr_1',
      ask('什么是 docker'),
    );

    expect(result.tutorMessage.text).toBe(DIAGNOSE_RESPONSE.answer);
    expect(agentClient.diagnose).toHaveBeenCalledWith(
      expect.objectContaining({
        lab_id: 'lab_1',
        current_step: expect.objectContaining({
          module_id: 'module_1',
          lesson_id: 'verify-virtual-machine',
          sequence: 2,
          title: '验证虚拟机',
        }),
      }),
    );
  });

  it('已学完整门课（指针为空且 enrollment 有 completedAt）时以最后一课为上下文，而不是第一课', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      completedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    prisma.progress.findUnique.mockResolvedValue({
      currentLessonContentId: null,
    });
    prisma.conversation.create.mockResolvedValue(conversationRow({}));
    agentClient.diagnose.mockResolvedValue(DIAGNOSE_RESPONSE);

    await service.sendMessage('user_1', 'enr_1', ask('复习一下'));

    expect(agentClient.diagnose).toHaveBeenCalledWith(
      expect.objectContaining({
        current_step: expect.objectContaining({
          lesson_id: 'verify-virtual-machine',
          sequence: 2,
        }),
      }),
    );
  });

  it('请求课时 ID 不存在时拒绝且不写聊天记录', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    await expect(
      service.sendMessage('user_1', 'enr_1', ask('？', 'missing-lesson')),
    ).rejects.toThrow();

    expect(agentClient.diagnose).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('无效的请求课时不写入对话历史', async () => {
    const { service, prisma } = await buildService();
    setupReadyWorkspace(prisma);
    await expect(
      service.sendMessage('user_1', 'enr_1', ask('？', 'deleted-lesson')),
    ).rejects.toThrow();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('最新已发布版本没有请求课时时拒绝且不调用 Agent', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.course.findUnique.mockResolvedValue({
      ...PUBLISHED_COURSE,
      versions: [
        {
          ...PUBLISHED_COURSE.versions[0],
          modules: [
            { ...PUBLISHED_COURSE.versions[0].modules[0], lessons: [] },
          ],
        },
      ],
    });
    await expect(
      service.sendMessage('user_1', 'enr_1', ask('？')),
    ).rejects.toThrow();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });

  it('请求课时已不在最新已发布版本时拒绝且不调用 Agent', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.course.findUnique.mockResolvedValue({
      ...PUBLISHED_COURSE,
      versions: [
        {
          ...PUBLISHED_COURSE.versions[0],
          modules: [
            {
              ...PUBLISHED_COURSE.versions[0].modules[0],
              lessons: [
                {
                  id: 'lesson_previous',
                  contentId: 'previous-lesson',
                  position: 1,
                  title: '前一课',
                  activityPrompt: '',
                },
              ],
            },
          ],
        },
      ],
    });
    await expect(
      service.sendMessage('user_1', 'enr_1', ask('？')),
    ).rejects.toThrow();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(agentClient.diagnose).not.toHaveBeenCalled();
  });

  it('请求课时缺少对应课程行时拒绝且不调用 Agent', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.courseLesson.findFirst.mockResolvedValue(null);
    await expect(
      service.sendMessage('user_1', 'enr_1', ask('？')),
    ).rejects.toThrow();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(agentClient.diagnose).not.toHaveBeenCalled();
    expect(prisma.courseLesson.findFirst).toHaveBeenCalledTimes(1);
  });
});

// An async iterator models the Agent stream even when test frames are immediate.
// eslint-disable-next-line @typescript-eslint/require-await
async function* framesFrom(frames: Array<{ event: string; data: unknown }>) {
  for (const frame of frames)
    yield { event: frame.event, data: JSON.stringify(frame.data) };
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
}

const DIAGNOSE_RESPONSE = {
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

describe('ChatService.streamMessage — 兜底路径（不调用 Agent）', () => {
  it('enrollment 不属于当前用户时拒绝，且不写入任何 Conversation', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(
      collect(service.streamMessage('user_1', 'enr_1', ask('你好'))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('没有 Workspace 记录时只发一个 complete 兜底事件，不调用 Agent', async () => {
    const { service, prisma, agentClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '你好' }),
    );
    prisma.workspace.findUnique.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '请先启动虚拟机后再提问。',
      }),
    );

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('你好')),
    );

    expect(events).toEqual([
      {
        type: 'complete',
        studentMessage: expect.objectContaining({ text: '你好' }),
        tutorMessage: expect.objectContaining({
          text: '请先启动虚拟机后再提问。',
        }),
      },
    ]);
    expect(agentClient.diagnoseStream).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });
});

describe('ChatService.streamMessage — 调用 Agent', () => {
  function setupReadyWorkspace(prisma: ReturnType<typeof buildPrisma>) {
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      labId: 'lab_1',
      status: WorkspaceStatus.RUNNING,
    });
    prisma.progress.findUnique.mockResolvedValue({
      currentLessonContentId: 'verify-virtual-machine',
    });
    prisma.course.findUnique.mockResolvedValue(PUBLISHED_COURSE);
    prisma.courseLesson.findFirst.mockResolvedValue({
      assessments: LESSON.assessments,
    });
  }

  it('restart 后迟到的流式结果不写聊天，但结算已发生的 token 用量', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1' }),
    );
    prisma.enrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        {
          event: 'result',
          data: {
            response: {
              ...DIAGNOSE_RESPONSE,
              usage: {
                input_cache_hit_tokens: 10,
                input_cache_miss_tokens: 20,
                output_tokens: 5,
              },
            },
          },
        },
      ]),
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('你好')),
    );

    expect(events).toEqual([]);
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(prisma.quotaLedger.upsert).toHaveBeenCalledWith({
      where: { id: expect.stringMatching(/^stale-agent-/) },
      update: {},
      create: expect.objectContaining({ userId: 'user_1', tokensDelta: -41 }),
    });
    jest.restoreAllMocks();
  });

  it('restart 后不再向客户端发送迟到的 progress 帧，并结算最终 usage', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1' }),
    );
    prisma.enrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        { event: 'reasoning_started', data: { turn: 1 } },
        {
          event: 'result',
          data: {
            response: {
              ...DIAGNOSE_RESPONSE,
              usage: {
                input_cache_hit_tokens: 10,
                input_cache_miss_tokens: 20,
                output_tokens: 5,
              },
            },
          },
        },
      ]),
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('stale')),
    );

    expect(events).toEqual([]);
    expect(prisma.quotaLedger.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expect.stringMatching(/^stale-agent-enr_1-0-/) },
        create: expect.objectContaining({ tokensDelta: -41 }),
      }),
    );
    jest.restoreAllMocks();
  });

  it('依次转发 progress 帧，result 帧落库后发 complete 事件', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: 'docker 装不上' }),
    );
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        { event: 'context_ready', data: { course_id: 'linux-basics' } },
        { event: 'reasoning_started', data: { turn: 1 } },
        { event: 'result', data: { response: DIAGNOSE_RESPONSE } },
        { event: 'done', data: { status: 'completed' } },
      ]),
    );
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: DIAGNOSE_RESPONSE.answer,
        contextRef: DIAGNOSE_RESPONSE,
      }),
    );

    const before = Date.now();
    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('docker 装不上')),
    );
    const after = Date.now();

    // 聊天本身就是"学生还在用这个 workspace"的活跃信号，不能只靠客户端独立的 60 秒心跳
    // 定时器——否则一次长对话中如果心跳意外断了，idle-sweep 可能会在对话中途把 VM 收掉。
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1' },
      data: { lastSeenAt: expect.any(Date) },
    });
    const touchedAt = prisma.workspace.update.mock.calls[0][0].data
      .lastSeenAt as Date;
    expect(touchedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(touchedAt.getTime()).toBeLessThanOrEqual(after);

    expect(events).toEqual([
      {
        type: 'progress',
        event: 'context_ready',
        data: { course_id: 'linux-basics' },
      },
      { type: 'progress', event: 'reasoning_started', data: { turn: 1 } },
      { type: 'progress', event: 'done', data: { status: 'completed' } },
      {
        type: 'complete',
        studentMessage: expect.objectContaining({ text: 'docker 装不上' }),
        tutorMessage: expect.objectContaining({
          text: DIAGNOSE_RESPONSE.answer,
        }),
      },
    ]);
    expect(prisma.conversation.create).toHaveBeenLastCalledWith({
      data: {
        enrollmentId: 'enr_1',
        threadId: 'enr_1',
        role: ConversationRole.ASSISTANT,
        content: DIAGNOSE_RESPONSE.answer,
        contextRef: DIAGNOSE_RESPONSE,
      },
    });
  });

  it('没有 Progress 记录时仍以请求课时作为流式上下文，result 落库后发 complete', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.progress.findUnique.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '什么是 docker' }),
    );
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([{ event: 'result', data: { response: DIAGNOSE_RESPONSE } }]),
    );
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: DIAGNOSE_RESPONSE.answer,
        contextRef: DIAGNOSE_RESPONSE,
      }),
    );

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('什么是 docker')),
    );

    expect(agentClient.diagnoseStream).toHaveBeenCalledWith(
      expect.objectContaining({
        lab_id: 'lab_1',
        current_step: expect.objectContaining({
          lesson_id: 'verify-virtual-machine',
          sequence: 2,
        }),
      }),
    );
    expect(events).toEqual([
      {
        type: 'complete',
        studentMessage: expect.objectContaining({ text: '什么是 docker' }),
        tutorMessage: expect.objectContaining({
          text: DIAGNOSE_RESPONSE.answer,
        }),
      },
    ]);
    expect(prisma.conversation.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        role: ConversationRole.ASSISTANT,
        content: DIAGNOSE_RESPONSE.answer,
        contextRef: DIAGNOSE_RESPONSE,
      }),
    });
  });

  it('流中途抛错、从没收到 result 帧时，转发已到达的 progress 后落兜底 complete 事件', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '？' }),
    );
    agentClient.diagnoseStream.mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/require-await
      (async function* () {
        yield {
          event: 'context_ready',
          data: JSON.stringify({ course_id: 'linux-basics' }),
        };
        throw new Error('stream aborted');
      })(),
    );
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '助教暂时不可用，请稍后再试。',
      }),
    );

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('？')),
    );

    expect(events).toEqual([
      {
        type: 'progress',
        event: 'context_ready',
        data: { course_id: 'linux-basics' },
      },
      {
        type: 'complete',
        studentMessage: expect.objectContaining({ text: '？' }),
        tutorMessage: expect.objectContaining({
          text: '助教暂时不可用，请稍后再试。',
        }),
      },
    ]);
  });

  it('result 帧响应格式不符合预期时，落兜底 complete 事件而不是把半成品传给 client', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '？' }),
    );
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        { event: 'result', data: { response: { status: 'completed' } } },
      ]),
    );
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({
        id: 'tutor_1',
        role: ConversationRole.ASSISTANT,
        content: '助教暂时不可用，请稍后再试。',
      }),
    );

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('？')),
    );

    expect(events).toEqual([
      {
        type: 'complete',
        studentMessage: expect.objectContaining({ text: '？' }),
        tutorMessage: expect.objectContaining({
          text: '助教暂时不可用，请稍后再试。',
        }),
      },
    ]);
  });

  it('result 落库（Assistant 消息）失败时，流干净结束而不是把异常炸穿到 SSE 连接上', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: 'docker 装不上' }),
    );
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        { event: 'reasoning_started', data: { turn: 1 } },
        { event: 'result', data: { response: DIAGNOSE_RESPONSE } },
      ]),
    );
    prisma.conversation.create.mockRejectedValueOnce(
      new Error('write failed: ECONNRESET'),
    );

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('docker 装不上')),
    );

    expect(events).toEqual([
      { type: 'progress', event: 'reasoning_started', data: { turn: 1 } },
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('enr_1'),
      expect.stringContaining('write failed: ECONNRESET'),
    );
    errorSpy.mockRestore();
  });

  it('已经转发过 progress 帧之后，兜底 complete 事件本身落库失败时，流干净结束而不是抛出未捕获异常', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    prisma.conversation.create.mockResolvedValueOnce(
      conversationRow({ id: 'student_1', content: '？' }),
    );
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        { event: 'context_ready', data: { course_id: 'linux-basics' } },
      ]),
    );
    prisma.conversation.create.mockRejectedValueOnce(
      new Error('write failed: ECONNRESET'),
    );

    const events = await collect(
      service.streamMessage('user_1', 'enr_1', ask('？')),
    );

    expect(events).toEqual([
      {
        type: 'progress',
        event: 'context_ready',
        data: { course_id: 'linux-basics' },
      },
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('enr_1'),
      expect.stringContaining('write failed: ECONNRESET'),
    );
    errorSpy.mockRestore();
  });
});

describe('ChatService — Agent 回复落库时记录 token usage', () => {
  const USAGE = {
    input_cache_hit_tokens: 1000,
    input_cache_miss_tokens: 200,
    output_tokens: 50,
  };
  const USAGE_COLUMNS = {
    inputCacheHitTokens: 1000,
    inputCacheMissTokens: 200,
    outputTokens: 50,
  };

  function setupReadyWorkspace(prisma: ReturnType<typeof buildPrisma>) {
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      labId: 'lab_1',
      status: WorkspaceStatus.RUNNING,
    });
    prisma.progress.findUnique.mockResolvedValue({
      currentLessonContentId: 'verify-virtual-machine',
    });
    prisma.course.findUnique.mockResolvedValue(PUBLISHED_COURSE);
    prisma.courseLesson.findFirst.mockResolvedValue({
      assessments: LESSON.assessments,
    });
    prisma.conversation.create.mockResolvedValue(conversationRow({}));
  }

  function assistantCreateData(prisma: ReturnType<typeof buildPrisma>) {
    const call = prisma.conversation.create.mock.calls.find(
      ([arg]) => arg.data.role === ConversationRole.ASSISTANT,
    );
    return call![0].data as Record<string, unknown>;
  }

  it('sendMessage：响应带 usage 时三列写进 ASSISTANT 行', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    agentClient.diagnose.mockResolvedValue({
      ...DIAGNOSE_RESPONSE,
      usage: USAGE,
    });

    await service.sendMessage('user_1', 'enr_1', ask('docker 装不上'));

    expect(assistantCreateData(prisma)).toMatchObject(USAGE_COLUMNS);
  });

  it('sendMessage：响应没有 usage 时不写任何 token 列（保持为空，不当成 0）', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    agentClient.diagnose.mockResolvedValue(DIAGNOSE_RESPONSE);

    await service.sendMessage('user_1', 'enr_1', ask('docker 装不上'));

    const data = assistantCreateData(prisma);
    expect(data).not.toHaveProperty('inputCacheHitTokens');
    expect(data).not.toHaveProperty('inputCacheMissTokens');
    expect(data).not.toHaveProperty('outputTokens');
  });

  it('sendMessage：usage 为 null 时同样不写 token 列', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    agentClient.diagnose.mockResolvedValue({
      ...DIAGNOSE_RESPONSE,
      usage: null,
    });

    await service.sendMessage('user_1', 'enr_1', ask('docker 装不上'));

    expect(assistantCreateData(prisma)).not.toHaveProperty('outputTokens');
  });

  it('sendMessage：Agent 失败走兜底话术时不写 token 列', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    agentClient.diagnose.mockRejectedValue(new Error('boom'));

    await service.sendMessage('user_1', 'enr_1', ask('docker 装不上'));

    expect(assistantCreateData(prisma)).not.toHaveProperty('outputTokens');
  });

  it('streamMessage：result 帧带 usage 时三列写进 ASSISTANT 行', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([
        {
          event: 'result',
          data: { response: { ...DIAGNOSE_RESPONSE, usage: USAGE } },
        },
      ]),
    );

    await collect(
      service.streamMessage('user_1', 'enr_1', ask('docker 装不上')),
    );

    expect(assistantCreateData(prisma)).toMatchObject(USAGE_COLUMNS);
  });

  it('streamMessage：result 帧没有 usage 时不写 token 列', async () => {
    const { service, prisma, agentClient } = await buildService();
    setupReadyWorkspace(prisma);
    agentClient.diagnoseStream.mockReturnValue(
      framesFrom([{ event: 'result', data: { response: DIAGNOSE_RESPONSE } }]),
    );

    await collect(
      service.streamMessage('user_1', 'enr_1', ask('docker 装不上')),
    );

    expect(assistantCreateData(prisma)).not.toHaveProperty('outputTokens');
  });
});
