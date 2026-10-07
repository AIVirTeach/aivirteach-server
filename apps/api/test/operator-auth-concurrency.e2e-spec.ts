import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { OperatorAdminService } from '../src/admin/operator-admin.service';
import { hashPassword } from '../src/auth/password';

// 需要 docker compose up -d 且已执行 prisma migrate；DATABASE_URL 必须指向本地库。
describe('运营登录：并发与时钟', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const stamp = Date.now();
  const password = 'operator-password-2026';
  const emails = {
    burst: `op-burst-${stamp}@example.com`,
    expired: `op-expired-${stamp}@example.com`,
    reset: `op-reset-${stamp}@example.com`,
  };

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
        { email: emails.burst, passwordHash },
        { email: emails.expired, passwordHash },
        { email: emails.reset, passwordHash },
      ],
    });
  });

  afterAll(async () => {
    const list = Object.values(emails);
    await prisma.operator.deleteMany({ where: { email: { in: list } } });
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: list } } });
    await prisma.$disconnect();
    await app.close();
  });

  const login = (email: string, pass: string) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ email, password: pass });

  it('并发错误密码：只锁一次、只记一条 locked 审计，之后正确密码也被拒绝', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () => login(emails.burst, 'wrong')),
    );

    const row = await prisma.operator.findUniqueOrThrow({
      where: { email: emails.burst },
    });
    expect(row.lockedUntil).not.toBeNull();
    await login(emails.burst, password).expect(401);
    await expect(
      prisma.auditEvent.count({
        where: { actorId: emails.burst, action: 'admin.auth.locked' },
      }),
    ).resolves.toBe(1);
  });

  it('锁定到期后的并发错误：重新从 1 数起，累计到 5 次再次锁定', async () => {
    await prisma.operator.update({
      where: { email: emails.expired },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() - 1000) },
    });

    await Promise.all(
      Array.from({ length: 8 }, () => login(emails.expired, 'wrong')),
    );

    const row = await prisma.operator.findUniqueOrThrow({
      where: { email: emails.expired },
    });
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  describe('passwordChangedAt 以数据库时钟为准，不受跑 CLI 的机器时钟影响', () => {
    const SKEW_MS = 60 * 60_000;
    // 只伪造 Date，其余定时器保持真实，数据库调用才不会被卡住。
    const skewClock = () =>
      jest.useFakeTimers({
        now: Date.now() + SKEW_MS,
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
          'queueMicrotask',
          'performance',
          'hrtime',
        ],
      });

    it('operator:reset', async () => {
      skewClock();
      try {
        await app.get(OperatorAdminService).reset(emails.reset, {
          operator: 'owner@example.com',
          reason: 'e2e',
          execute: true,
        });
      } finally {
        jest.useRealTimers();
      }

      const row = await prisma.operator.findUniqueOrThrow({
        where: { email: emails.reset },
      });
      expect(
        Math.abs(row.passwordChangedAt.getTime() - Date.now()),
      ).toBeLessThan(30_000);
    });
  });
});
