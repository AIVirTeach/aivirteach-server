import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { verifyAdminAccessToken, verifyAccessToken } from '../src/auth/tokens';

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
});
