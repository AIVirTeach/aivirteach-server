import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, WorkspaceStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  AgentClient,
  type DiagnoseResponseBody,
} from '../src/chat/agent-client';
import { signAccessToken } from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。不依赖真实 aivirteach-labs Agent 服务
// （LABS_AGENT_BASE_URL 在测试环境不配置）——大部分用例只验证"VM 未就绪 → 兜底消息"这条不需要
// 外部服务的路径；Agent 真实调用已经在这次设计的连通性测试里手动验证过。最后一条用例用
// jest.spyOn 替身 AgentClient.diagnose，专门用真实 Postgres 跑一遍 buildDiagnoseContext 的
// Prisma 关联查询（Course → CourseVersion → CourseModule → CourseLesson → LessonAssessment），
// 单测里这条路径全程 mock Prisma，从没真正跑过这串 include 链。
describe('Chat 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const jwtSecret = process.env.JWT_SECRET ?? '';
  const email = `chat-e2e-${Date.now()}@example.com`;
  const otherEmail = `chat-e2e-other-${Date.now()}@example.com`;
  const courseSlug = `chat-e2e-course-${Date.now()}`;
  let enrollmentId: string;
  let courseId: string;
  let courseVersionId: string;
  let courseModuleId: string;
  let accessToken: string;
  let otherAccessToken: string;

  const command = (
    text: string,
    overrides: {
      requestId?: string;
      courseVersionId?: string;
      lessonId?: string;
      generation?: number;
    } = {},
  ) => ({
    requestId: overrides.requestId ?? randomUUID(),
    text,
    context: {
      courseVersionId: overrides.courseVersionId ?? courseVersionId,
      lessonId: overrides.lessonId ?? 'verify-virtual-machine',
      generation: overrides.generation ?? 0,
    },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // main.ts 里 setGlobalPrefix('api/v1') 只在真实 bootstrap 时跑，这里是独立创建的测试 app，
    // 同一行必须重复一遍，否则所有 /api/v1/* 路径都 404。
    app.setGlobalPrefix('api/v1');
    await app.init();

    const user = await prisma.user.create({ data: { email } });
    const otherUser = await prisma.user.create({ data: { email: otherEmail } });
    const course = await prisma.course.create({
      data: { slug: courseSlug, title: '测试课程', published: true },
    });
    courseId = course.id;
    const version = await prisma.courseVersion.create({
      data: { courseId, version: 1, publishedAt: new Date() },
    });
    courseVersionId = version.id;
    const courseModule = await prisma.courseModule.create({
      data: {
        courseVersionId,
        position: 1,
        title: '模块一',
        description: '',
        estimatedMinutes: 30,
      },
    });
    courseModuleId = courseModule.id;
    const lesson = await prisma.courseLesson.create({
      data: {
        moduleId: courseModule.id,
        contentId: 'verify-virtual-machine',
        position: 1,
        title: '验证虚拟机',
        estimatedMinutes: 10,
        sourceRange: {},
        activityType: 'terminal',
        activityPrompt: '打开终端\n运行 docker --version',
        activityCompletionType: 'auto',
      },
    });
    await prisma.lessonAssessment.create({
      data: {
        lessonId: lesson.id,
        type: 'terminal',
        question: '确认 docker 已安装',
        expectedResult: '看到 docker 版本号',
        successCriteria: ['命令成功执行'],
        commonFailures: ['docker 服务未启动'],
      },
    });
    await prisma.courseLesson.create({
      data: {
        moduleId: courseModule.id,
        contentId: 'another-lesson',
        position: 2,
        title: '另一课',
        estimatedMinutes: 8,
        sourceRange: {},
        activityType: 'terminal',
        activityPrompt: '另一组已加载的操作步骤',
        activityCompletionType: 'manual',
      },
    });
    const enrollment = await prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id },
    });
    enrollmentId = enrollment.id;

    accessToken = await signAccessToken(
      { sub: user.id, email: user.email },
      jwtSecret,
      '15m',
    );
    otherAccessToken = await signAccessToken(
      { sub: otherUser.id, email: otherUser.email },
      jwtSecret,
      '15m',
    );
  });

  afterAll(async () => {
    // Course 删除会级联删掉 Enrollment，Enrollment 删除会级联删掉 Conversation。
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({
      where: { email: { in: [email, otherEmail] } },
    });
    await prisma.$disconnect();
    await app.close();
  });

  it('无 token 访问返回 401', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .expect(401);
  });

  it('text 为空时返回 400 并指出字段', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(command(''))
      .expect(400);

    expect(response.body.issues.map((i: { path: string }) => i.path)).toContain(
      'text',
    );
  });

  it('访问不属于自己的 enrollment 返回 403', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .send(command('你好'))
      .expect(403);
  });

  it('VM 未就绪时落兜底消息，并能通过 GET 读回历史', async () => {
    const sent = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(command('虚拟机装不上 docker'))
      .expect(200);

    expect(sent.body.studentMessage.text).toBe('虚拟机装不上 docker');
    expect(sent.body.tutorMessage.text).toBe('请先启动虚拟机后再提问。');

    const history = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages?generation=0`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(history.body).toHaveLength(2);
    expect(history.body[0].role).toBe('student');
    expect(history.body[1].role).toBe('tutor');
  });

  it('history 必须显式提供 generation', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('history 拒绝空 generation 和重复 generation 参数', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .query({ generation: '' })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .query({ generation: ['0', '1'] })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('SSE 在提交响应头前校验明确课时，错误上下文返回 404 且不写用户消息', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(command('invalid lesson', { lessonId: 'missing-lesson' }));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('lesson_not_found');
    await expect(
      prisma.conversation.count({
        where: { enrollmentId, content: 'invalid lesson' },
      }),
    ).resolves.toBe(0);
  });

  it('同步和流式共用请求 ID 时仅接受第一次提交', async () => {
    const body = command('same request across tabs');
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(200);

    const duplicate = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(409);

    expect(duplicate.body.code).toBe('chat_request_exists');
    await expect(
      prisma.conversation.count({
        where: { enrollmentId, requestId: body.requestId },
      }),
    ).resolves.toBe(2);
  });

  it('并行标签页使用相同请求 ID 时只有一个请求被接受', async () => {
    const body = command('parallel tabs');
    const send = () =>
      request(app.getHttpServer())
        .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    await expect(
      prisma.conversation.count({
        where: { enrollmentId, requestId: body.requestId },
      }),
    ).resolves.toBe(2);
  });

  it('旧聊天完成接口已移除', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/lessons/verify-virtual-machine/complete')
      .expect(404);
  });

  it('工作区就绪且有当前课时时，真实拼出 CourseContext/LessonContext 传给 Agent，成功响应落 ASSISTANT 消息并存完整 contextRef', async () => {
    const lesson = await prisma.courseLesson.findFirst({
      where: { moduleId: courseModuleId },
    });
    await prisma.workspace.create({
      data: {
        enrollmentId,
        status: WorkspaceStatus.RUNNING,
        labId: `lab_${Date.now()}`,
      },
    });
    if (!lesson) throw new Error('Expected seeded lesson');
    await prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        learningState: {
          schemaVersion: 1,
          readingLessonId: lesson.contentId,
          lessons: {},
          completedAt: null,
        },
      },
    });

    const diagnoseResponse: DiagnoseResponseBody = {
      request_id: 'e2e-req-1',
      status: 'completed',
      answer: '试试重启 docker 服务',
      diagnosis: {},
      course_alignment: {},
      evidence: [],
      suggested_actions: [],
      limitations: [],
      tool_trace: [],
    };
    const diagnoseSpy = jest
      .spyOn(app.get(AgentClient), 'diagnose')
      .mockResolvedValue(diagnoseResponse);

    const sent = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(command('docker 装不上'))
      .expect(200);

    expect(sent.body.tutorMessage.text).toBe('试试重启 docker 服务');
    expect(diagnoseSpy).toHaveBeenCalledWith({
      request_id: expect.any(String),
      lab_id: expect.stringMatching(/^lab_/),
      question: 'docker 装不上',
      course: {
        course_id: courseSlug,
        version: 1,
        title: '测试课程',
        summary: '',
      },
      current_step: {
        module_id: courseModuleId,
        lesson_id: 'verify-virtual-machine',
        sequence: 1,
        title: '验证虚拟机',
        instructions: ['打开终端', '运行 docker --version'],
        expected_result: '看到 docker 版本号',
        success_criteria: ['命令成功执行'],
        common_failures: [{ code: 'docker 服务未启动', symptoms: [] }],
      },
    });

    const stored = await prisma.conversation.findFirst({
      where: { enrollmentId, content: '试试重启 docker 服务' },
    });
    expect(stored?.contextRef).toEqual(diagnoseResponse);
    expect(stored?.acceptedContext).toEqual({
      course: {
        course_id: courseSlug,
        version: 1,
        title: '测试课程',
        summary: '',
      },
      current_step: {
        module_id: courseModuleId,
        lesson_id: 'verify-virtual-machine',
        sequence: 1,
        title: '验证虚拟机',
        instructions: ['打开终端', '运行 docker --version'],
        expected_result: '看到 docker 版本号',
        success_criteria: ['命令成功执行'],
        common_failures: [{ code: 'docker 服务未启动', symptoms: [] }],
      },
    });

    diagnoseSpy.mockRestore();
  });

  it('两个标签页的不同已加载课时分别作为 Agent 上下文', async () => {
    const diagnoseSpy = jest
      .spyOn(app.get(AgentClient), 'diagnose')
      .mockImplementation((input) =>
        Promise.resolve({
          request_id: input.request_id,
          status: 'completed',
          answer: input.current_step.title,
          diagnosis: {},
          course_alignment: {},
          evidence: [],
          suggested_actions: [],
          limitations: [],
          tool_trace: [],
        }),
      );
    for (const [lessonId, expectedTitle] of [
      ['verify-virtual-machine', '验证虚拟机'],
      ['another-lesson', '另一课'],
    ]) {
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(command(`question about ${lessonId}`, { lessonId }))
        .expect(200);
      expect(diagnoseSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          current_step: expect.objectContaining({
            lesson_id: lessonId,
            title: expectedTitle,
          }),
        }),
      );
    }
    diagnoseSpy.mockRestore();
  });

  it('Agent 等待期间发布新版后仍完成最初接受的课程上下文', async () => {
    let beginAgent!: () => void;
    let finishAgent!: (value: DiagnoseResponseBody) => void;
    const started = new Promise<void>((resolve) => {
      beginAgent = resolve;
    });
    const result = new Promise<DiagnoseResponseBody>((resolve) => {
      finishAgent = resolve;
    });
    const diagnoseSpy = jest
      .spyOn(app.get(AgentClient), 'diagnose')
      .mockImplementation(async () => {
        beginAgent();
        return result;
      });
    const pending = request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(command('frozen context'))
      .then((response) => response);
    await started;
    const publishedV2 = await prisma.courseVersion.create({
      data: { courseId, version: 2, publishedAt: new Date() },
    });
    const moduleV2 = await prisma.courseModule.create({
      data: {
        courseVersionId: publishedV2.id,
        position: 1,
        title: '新版模块',
        description: '',
        estimatedMinutes: 30,
      },
    });
    await prisma.courseLesson.create({
      data: {
        moduleId: moduleV2.id,
        contentId: 'verify-virtual-machine',
        position: 1,
        title: '新版课时',
        estimatedMinutes: 10,
        sourceRange: {},
        activityType: 'terminal',
        activityPrompt: '已发布的新版步骤',
        activityCompletionType: 'auto',
      },
    });
    await prisma.course.update({
      where: { id: courseId },
      data: { title: '新版课程标题', description: '新版课程介绍' },
    });
    finishAgent({
      request_id: randomUUID(),
      status: 'completed',
      answer: '完成',
      diagnosis: {},
      course_alignment: {},
      evidence: [],
      suggested_actions: [],
      limitations: [],
      tool_trace: [],
    });
    expect((await pending).status).toBe(200);
    expect(diagnoseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        course: {
          course_id: courseSlug,
          version: 1,
          title: '测试课程',
          summary: '',
        },
        current_step: expect.objectContaining({
          instructions: ['打开终端', '运行 docker --version'],
        }),
      }),
    );
    const accepted = await prisma.conversation.findFirst({
      where: { enrollmentId, content: 'frozen context', role: 'USER' },
    });
    expect(accepted?.acceptedContext).toMatchObject({
      course: { version: 1, title: '测试课程', summary: '' },
      current_step: {
        lesson_id: 'verify-virtual-machine',
        instructions: ['打开终端', '运行 docker --version'],
      },
    });
    diagnoseSpy.mockRestore();
  });

  it('restart 后旧代请求拒绝且不会写入新代对话', async () => {
    const progress = await request(app.getHttpServer())
      .get(`/api/v1/courses/${courseSlug}/progress`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseSlug}/restart`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        requestId: randomUUID(),
        generation: progress.body.generation,
        revision: progress.body.revision,
        courseVersionId: progress.body.courseVersionId,
      })
      .expect(201);
    const oldRequest = command('old generation', { generation: 0 });
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(oldRequest)
      .expect(409);
    await expect(
      prisma.conversation.count({
        where: { enrollmentId, requestId: oldRequest.requestId },
      }),
    ).resolves.toBe(0);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages?generation=0`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages?generation=1`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
    await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseSlug}/enroll`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages?generation=1`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect([]);
  });
});
