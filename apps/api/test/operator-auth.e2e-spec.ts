import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  createOperatorSession,
  type OperatorSession,
} from './helpers/operator-session';
import { OperatorAdminService } from '../src/admin/operator-admin.service';
import { hashPassword } from '../src/auth/password';
import {
  signAccessToken,
  verifyAccessToken,
  verifyAdminAccessToken,
} from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。
describe('运营登录端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const stamp = Date.now();
  const email = `op-${stamp}@example.com`;
  const lockedEmail = `op-locked-${stamp}@example.com`;
  const password = 'operator-password-2026';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    const passwordHash = await hashPassword(password);
    await prisma.operator.createMany({
      data: [
        { email, passwordHash },
        { email: lockedEmail, passwordHash },
      ],
    });
  });

  afterAll(async () => {
    await prisma.operator.deleteMany({
      where: { email: { in: [email, lockedEmail] } },
    });
    await prisma.auditEvent.deleteMany({
      where: { actorId: { in: [email, lockedEmail] } },
    });
    await prisma.$disconnect();
    await app.close();
  });

  const login = (body: object) =>
    request(app.getHttpServer()).post('/api/v1/admin/auth/login').send(body);

  it('登录成功：返回 admin audience 的 access token，学员侧验不过', async () => {
    const res = await login({
      email: ` ${email.toUpperCase()} `,
      password,
    }).expect(200);

    const secret = process.env.JWT_SECRET!;
    await expect(
      verifyAdminAccessToken(res.body.accessToken, secret),
    ).resolves.toMatchObject({ email });
    await expect(
      verifyAccessToken(res.body.accessToken, secret),
    ).rejects.toThrow();
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.expiresIn).toBeGreaterThan(0);
  });

  it('密码错和邮箱不存在得到完全相同的 401', async () => {
    const wrong = await login({ email, password: 'nope' }).expect(401);
    const missing = await login({
      email: `nobody-${stamp}@example.com`,
      password: 'nope',
    }).expect(401);

    expect(wrong.body).toEqual(missing.body);
    expect(wrong.body.message).toBe('凭证无效');
  });

  it('超长密码直接 400', async () => {
    await login({ email, password: 'a'.repeat(129) }).expect(400);
  });

  it('连续 5 次失败后锁定：正确密码也 401，并留下 admin.auth.locked 审计', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login({ email: lockedEmail, password: 'wrong' }).expect(401);
    }

    await login({ email: lockedEmail, password }).expect(401);

    const locked = await prisma.auditEvent.findMany({
      where: { actorId: lockedEmail, action: 'admin.auth.locked' },
    });
    expect(locked).toHaveLength(1);
  });

  it('学员登录接口不接受运营凭证', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(401);
  });

  it('operator:add 输出的密码可以直接登录，并用该令牌写入 admin 接口、审计记为该运营', async () => {
    const created = `op-cli-${stamp}@example.com`;
    const cliSlug = `cli-e2e-${stamp}`;
    try {
      const added = await app.get(OperatorAdminService).add(created, {
        operator: 'owner@example.com',
        reason: 'e2e',
        execute: true,
      });

      const res = await login({
        email: created,
        password: added.password,
      }).expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/admin/courses')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .send({ slug: cliSlug, title: 'CLI 联调' })
        .expect(201);

      await expect(
        prisma.auditEvent.count({
          where: {
            actorType: 'OPERATOR',
            actorId: created,
            targetType: 'Course',
          },
        }),
      ).resolves.toBeGreaterThan(0);
    } finally {
      await prisma.course.deleteMany({ where: { slug: cliSlug } });
      await prisma.operator.deleteMany({ where: { email: created } });
      await prisma.auditEvent.deleteMany({
        where: { actorId: { in: [created, 'owner@example.com'] } },
      });
    }
  });

  describe('OperatorAuthGuard 保护的 admin 接口', () => {
    let session: OperatorSession;
    const slug = `guard-e2e-${stamp}`;

    beforeAll(async () => {
      session = await createOperatorSession(prisma, 'guard');
    });

    afterAll(async () => {
      await prisma.course.deleteMany({ where: { slug } });
      await session.cleanup();
    });

    const createCourse = (
      token: string,
      headers: Record<string, string> = {},
    ) =>
      request(app.getHttpServer())
        .post('/api/v1/admin/courses')
        .set('Authorization', `Bearer ${token}`)
        .set(headers)
        .send({ slug, title: '守卫测试课' });

    it('审计里的 actorId 是登录运营的邮箱，自报的 X-Operator 被忽略', async () => {
      await createCourse(session.token, {
        'X-Operator': 'attacker@example.com',
      }).expect(201);

      const events = await prisma.auditEvent.findMany({
        where: {
          targetType: 'Course',
          actorType: 'OPERATOR',
          actorId: session.email,
        },
      });
      expect(events.length).toBeGreaterThan(0);
      await expect(
        prisma.auditEvent.count({ where: { actorId: 'attacker@example.com' } }),
      ).resolves.toBe(0);
    });

    it('学员令牌调 admin 接口 → 401', async () => {
      const learnerToken = await signAccessToken(
        { sub: 'user_x', email: 'learner@example.com' },
        process.env.JWT_SECRET ?? '',
        '15m',
      );

      await createCourse(learnerToken).expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/admin/token-usage')
        .set('Authorization', `Bearer ${learnerToken}`)
        .expect(401);
    });

    it('运营令牌调学员接口 → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${session.token}`)
        .expect(401);
    });

    it('运营被停用后，仍在有效期内的令牌下一次请求就 401', async () => {
      const other = await createOperatorSession(prisma, 'disabled');
      await request(app.getHttpServer())
        .get('/api/v1/admin/token-usage')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      await prisma.operator.update({
        where: { email: other.email },
        data: { status: 'DISABLED' },
      });

      await request(app.getHttpServer())
        .get('/api/v1/admin/token-usage')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(401);
      await other.cleanup();
    });

    it('改密码后，改之前签发的令牌失效', async () => {
      const other = await createOperatorSession(prisma, 'reset');
      await prisma.operator.update({
        where: { email: other.email },
        data: { passwordChangedAt: new Date(Date.now() + 5000) },
      });

      await request(app.getHttpServer())
        .get('/api/v1/admin/token-usage')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(401);
      await other.cleanup();
    });
  });
});
