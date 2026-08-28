import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { signAccessToken } from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。不依赖真实 aivirteach-labs Agent 服务
// （LABS_AGENT_BASE_URL 在测试环境不配置）——这里只验证"VM 未就绪 → 兜底消息"这条不需要
// 外部服务的路径；Agent 真实调用已经在这次设计的连通性测试里手动验证过。
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
});
