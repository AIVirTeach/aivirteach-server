import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  createOperatorSession,
  type OperatorSession,
} from './helpers/operator-session';

// 需要 docker compose up -d 且已执行 prisma migrate。
// 夹具放在 2031 年窗口里，避免混进库里其他数据。
describe('GET /admin/token-usage 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  let operator: OperatorSession;
  const stamp = Date.now();
  const email = `usage-admin-${stamp}@example.com`;
  const slug = `usage-admin-course-${stamp}`;
  let userId: string;
  let courseId: string;
  const window = 'from=2031-04-01T00:00:00Z&to=2031-04-02T00:00:00Z';

  beforeAll(async () => {
    operator = await createOperatorSession(prisma, 'e2e');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    userId = (await prisma.user.create({ data: { email } })).id;
    courseId = (
      await prisma.course.create({
        data: { slug, title: slug, published: true },
      })
    ).id;
    const enrollmentId = (
      await prisma.enrollment.create({ data: { userId, courseId } })
    ).id;
    await prisma.conversation.create({
      data: {
        enrollmentId,
        threadId: enrollmentId,
        role: ConversationRole.ASSISTANT,
        content: 'reply',
        contextRef: {},
        createdAt: new Date('2031-04-01T10:00:00Z'),
        inputCacheHitTokens: 1000,
        inputCacheMissTokens: 200,
        outputTokens: 50,
      },
    });
    // 窗口（2031-04-01 当天）之外的历史消耗：Guard 会算，窗口报表的 weightedConsumption 不算。
    await prisma.conversation.create({
      data: {
        enrollmentId,
        threadId: enrollmentId,
        role: ConversationRole.ASSISTANT,
        content: 'older reply',
        contextRef: {},
        createdAt: new Date('2031-03-01T10:00:00Z'),
        inputCacheHitTokens: 0,
        inputCacheMissTokens: 100,
        outputTokens: 0,
      },
    });
    await prisma.quotaLedger.create({ data: { userId, tokensDelta: 1000 } });
  });

  afterAll(async () => {
    await operator.cleanup();
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
    await app.close();
  });

  it('没有 admin 令牌返回 401', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/token-usage?${window}`)
      .expect(401);
  });

  it('错误的 admin 令牌返回 401', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/token-usage?${window}`)
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
  });

  it('按用户分组：返回三类 token、加权消耗、覆盖率、发放额度和余额', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/token-usage?${window}&groupBy=user`)
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    // 默认权重 0.02 / 1 / 4：窗口内 ceil(1000*0.02 + 200*1 + 50*4) = 420；
    // 全期再加窗口外的 100 个 miss = 520，余额必须按全期算（和 Guard 一致）。
    expect(response.body).toContainEqual({
      key: userId,
      label: email,
      inputCacheHitTokens: 1000,
      inputCacheMissTokens: 200,
      outputTokens: 50,
      weightedConsumption: 420,
      meteredTurns: 1,
      unmeteredTurns: 0,
      grantedTokens: 1000,
      lifetimeConsumption: 520,
      balance: 480,
    });
  });

  it('按课程分组：不带发放额度和余额字段', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/token-usage?${window}&groupBy=course`)
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    const row = response.body.find((r: { key: string }) => r.key === courseId);
    expect(row).toMatchObject({ label: slug, weightedConsumption: 420 });
    expect(row).not.toHaveProperty('balance');
  });

  it('参数非法返回 400 并指出字段', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/token-usage?groupBy=enrollment')
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(400);

    expect(response.body.issues.map((i: { path: string }) => i.path)).toContain(
      'groupBy',
    );
  });
});
