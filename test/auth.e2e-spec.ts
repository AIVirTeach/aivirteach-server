import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { generateOpaqueToken, hashOpaqueToken } from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。
describe('Auth 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const email = `e2e-${Date.now()}@example.com`;
  const inviteToken = generateOpaqueToken();
  const password = 'closed-beta-2026';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // main.ts 里 setGlobalPrefix('api/v1') 只在真实 bootstrap 时跑，
    // 这里是独立创建的测试 app，同一行必须重复一遍，否则所有 /api/v1/* 路径都 404。
    app.setGlobalPrefix('api/v1');
    await app.init();

    await prisma.user.create({
      data: {
        email,
        invitations: {
          create: {
            tokenHash: hashOpaqueToken(inviteToken),
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
    await app.close();
  });

  it('接受邀请 → 登录 → 访问 /auth/me → 刷新 → 登出 全流程', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/auth/invitations/accept')
      .send({ token: inviteToken, password })
      .expect(200);
    expect(accepted.body.accessToken).toBeDefined();

    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(email);

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: loggedIn.body.refreshToken })
      .expect(200);
    expect(refreshed.body.refreshToken).not.toBe(loggedIn.body.refreshToken);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(204);
  });

  it('重放已轮换的 refresh token 被拒绝', async () => {
    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: loggedIn.body.refreshToken })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: loggedIn.body.refreshToken })
      .expect(401);
  });

  it('无 token 访问 /auth/me 返回 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('邮箱格式错误返回 400 并指出字段', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'whatever' })
      .expect(400);

    expect(response.body.issues.map((i: { path: string }) => i.path)).toContain(
      'email',
    );
  });
});
