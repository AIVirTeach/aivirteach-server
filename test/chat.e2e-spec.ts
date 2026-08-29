import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, WorkspaceStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AgentClient, type DiagnoseResponseBody } from '../src/chat/agent-client';
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
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // main.ts 里 setGlobalPrefix('api/v1') 只在真实 bootstrap 时跑，这里是独立创建的测试 app，
    // 同一行必须重复一遍，否则所有 /api/v1/* 路径都 404。
    app.setGlobalPrefix('api/v1');
    await app.init();

    const user = await prisma.user.create({ data: { email } });
    const otherUser = await prisma.user.create({ data: { email: otherEmail } });
    const course = await prisma.course.create({ data: { slug: courseSlug, title: '测试课程', published: true } });
    courseId = course.id;
    const enrollment = await prisma.enrollment.create({ data: { userId: user.id, courseId: course.id } });
    enrollmentId = enrollment.id;

    accessToken = await signAccessToken({ sub: user.id, email: user.email }, jwtSecret, '15m');
    otherAccessToken = await signAccessToken({ sub: otherUser.id, email: otherUser.email }, jwtSecret, '15m');
  });

  afterAll(async () => {
    // Course 删除会级联删掉 Enrollment，Enrollment 删除会级联删掉 Conversation。
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    await prisma.$disconnect();
    await app.close();
  });

  it('无 token 访问返回 401', async () => {
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${enrollmentId}/chat/messages`).expect(401);
  });

  it('text 为空时返回 400 并指出字段', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '' })
      .expect(400);

    expect(response.body.issues.map((i: { path: string }) => i.path)).toContain('text');
  });

  it('访问不属于自己的 enrollment 返回 403', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .send({ text: '你好' })
      .expect(403);
  });

  it('VM 未就绪时落兜底消息，并能通过 GET 读回历史', async () => {
    const sent = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '虚拟机装不上 docker' })
      .expect(200);

    expect(sent.body.studentMessage.text).toBe('虚拟机装不上 docker');
    expect(sent.body.tutorMessage.text).toBe('请先启动虚拟机后再提问。');

    const history = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${enrollmentId}/chat/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(history.body).toHaveLength(2);
    expect(history.body[0].role).toBe('student');
    expect(history.body[1].role).toBe('tutor');
  });

  it('工作区就绪且有当前课时时，真实拼出 CourseContext/LessonContext 传给 Agent，成功响应落 ASSISTANT 消息并存完整 contextRef', async () => {
    const courseVersion = await prisma.courseVersion.create({
      data: { courseId, version: 1 },
    });
    const courseModule = await prisma.courseModule.create({
      data: { courseVersionId: courseVersion.id, position: 1, title: '模块一', description: '', estimatedMinutes: 30 },
    });
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
    await prisma.workspace.create({
      data: { enrollmentId, status: WorkspaceStatus.RUNNING, labId: `lab_${Date.now()}` },
    });
    await prisma.progress.create({ data: { enrollmentId, currentLessonId: lesson.id } });

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
      .send({ text: 'docker 装不上' })
      .expect(200);

    expect(sent.body.tutorMessage.text).toBe('试试重启 docker 服务');
    expect(diagnoseSpy).toHaveBeenCalledWith({
      request_id: expect.any(String),
      lab_id: expect.stringMatching(/^lab_/),
      question: 'docker 装不上',
      course: { course_id: courseSlug, version: 1, title: '测试课程', summary: '' },
      current_step: {
        module_id: courseModule.id,
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

    diagnoseSpy.mockRestore();
  });
});
