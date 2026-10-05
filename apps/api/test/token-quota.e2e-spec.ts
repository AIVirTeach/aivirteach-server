import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { signAccessToken } from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。
// 验证 Guard 挂在聊天的两条 POST 路由上，且流式路由（@Sse，响应头会先于 handler 提交）
// 也能拿到真正的 HTTP 429——这正是把检查放在 Guard 而不是 ChatService 里的原因。
describe('Token 额度 Guard 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const stamp = Date.now();
  const email = `quota-e2e-${stamp}@example.com`;
  const courseSlug = `quota-e2e-course-${stamp}`;
  const previousEnforced = process.env.TOKEN_QUOTA_ENFORCED;
  let userId: string;
  let courseId: string;
  let enrollmentId: string;
  let accessToken: string;

  const messagesUrl = () => `/api/v1/workspaces/${enrollmentId}/chat/messages`;

  beforeAll(async () => {
    // ConfigModule 在模块编译时读 process.env，必须在 createTestingModule 之前设置。
    process.env.TOKEN_QUOTA_ENFORCED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    const user = await prisma.user.create({ data: { email } });
    userId = user.id;
    const course = await prisma.course.create({
      data: { slug: courseSlug, title: '额度测试课', published: true },
    });
    courseId = course.id;
    // restart 要求课程至少有一个已发布版本。
    await prisma.courseVersion.create({
      data: { courseId, version: 1, publishedAt: new Date() },
    });
    enrollmentId = (
      await prisma.enrollment.create({ data: { userId, courseId } })
    ).id;
    accessToken = await signAccessToken(
      { sub: user.id, email },
      process.env.JWT_SECRET ?? '',
      '15m',
    );
  });

  afterAll(async () => {
    if (previousEnforced === undefined) delete process.env.TOKEN_QUOTA_ENFORCED;
    else process.env.TOKEN_QUOTA_ENFORCED = previousEnforced;
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
    await app.close();
  });

  it('从未发放过 token 额度：普通路由返回 429 + TOKEN_QUOTA_EXHAUSTED，且不写任何 Conversation', async () => {
    const response = await request(app.getHttpServer())
      .post(messagesUrl())
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '你好' })
      .expect(429);

    expect(response.body.code).toBe('TOKEN_QUOTA_EXHAUSTED');
    await expect(
      prisma.conversation.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
  });

  it('额度用尽：流式路由同样是真正的 HTTP 429，不是先返回 200 再在流里报错', async () => {
    const response = await request(app.getHttpServer())
      .post(`${messagesUrl()}/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '你好' })
      .expect(429);

    expect(response.body.code).toBe('TOKEN_QUOTA_EXHAUSTED');
    await expect(
      prisma.conversation.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
  });

  it('读取历史消息不受额度限制', async () => {
    await request(app.getHttpServer())
      .get(messagesUrl())
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('发放额度后放行（这里 VM 未就绪，走兜底话术，说明已越过 Guard）', async () => {
    await prisma.quotaLedger.create({ data: { userId, tokensDelta: 1000 } });

    const response = await request(app.getHttpServer())
      .post(messagesUrl())
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '你好' })
      .expect(200);

    expect(response.body.tutorMessage.text).toBe('请先启动虚拟机后再提问。');
  });

  it('额度被消耗光之后重新被拦截', async () => {
    // 1000 额度，写一条 outputTokens=250 的回复 -> 加权消耗 250*4 = 1000，余额恰为 0。
    await prisma.conversation.create({
      data: {
        enrollmentId,
        threadId: enrollmentId,
        role: 'ASSISTANT',
        content: 'r',
        outputTokens: 250,
      },
    });

    await request(app.getHttpServer())
      .post(messagesUrl())
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '再问一次' })
      .expect(429);
  });

  it('restart 清空对话后消耗不会被清零：额度仍然用尽，无法靠重来续杯', async () => {
    // 上一条用例已把余额消耗到 0（对话里有 250 个 output token -> 加权 1000）。
    await request(app.getHttpServer())
      .post('/api/v1/courses/' + courseSlug + '/restart')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);

    await expect(
      prisma.conversation.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
    await request(app.getHttpServer())
      .post(messagesUrl())
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '重来后再问' })
      .expect(429);
  });
});
