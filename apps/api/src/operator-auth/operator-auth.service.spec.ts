import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';
import { TOKEN_AUDIENCE_ADMIN, verifyAdminAccessToken } from '../auth/tokens';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuthService } from './operator-auth.service';

const SECRET = 'a'.repeat(48);
const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: SECRET,
  OPERATOR_SESSION_TTL: '8h',
};

type OperatorRow = {
  id: string;
  email: string;
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
  failedLoginCount: number;
  lockedUntil: Date | null;
};

const buildOperator = async (
  overrides: Partial<OperatorRow> = {},
): Promise<OperatorRow> => ({
  id: 'op_1',
  email: 'op@example.com',
  passwordHash: await hashPassword('correct-password'),
  status: 'ACTIVE',
  failedLoginCount: 0,
  lockedUntil: null,
  ...overrides,
});

const buildService = async () => {
  const prisma = {
    operator: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      OperatorAuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(OperatorAuthService), prisma, audit };
};

const denied = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UnauthorizedException);
  expect((error as UnauthorizedException).message).toBe('凭证无效');
};

describe('OperatorAuthService.login', () => {
  it('凭证正确：返回 admin audience 的 access token、清零计数并记成功审计', async () => {
    const { service, prisma, audit } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({ failedLoginCount: 3 }),
    );

    const session = await service.login('op@example.com', 'correct-password');

    const claims = await verifyAdminAccessToken(session.accessToken, SECRET);
    expect(claims).toMatchObject({ sub: 'op_1', email: 'op@example.com' });
    expect(session.expiresIn).toBe(8 * 3600);
    expect(TOKEN_AUDIENCE_ADMIN).toBe('aivirteach-admin');
    expect(prisma.operator.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'op_1',
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: expect.any(Date) } }],
      },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'OPERATOR', id: 'op@example.com' },
        action: 'admin.auth.login',
        success: true,
      }),
    );
  });

  it('校验密码期间被并发请求锁定：即使密码正确也 401，不签发令牌、记失败审计', async () => {
    const { service, prisma, audit } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(await buildOperator());
    prisma.operator.updateMany.mockResolvedValue({ count: 0 });

    await denied(service.login('op@example.com', 'correct-password'));

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.auth.login', success: false }),
    );
  });

  it('密码错：统一 401「凭证无效」、失败计数 +1、记失败审计', async () => {
    const { service, prisma, audit } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(await buildOperator());
    prisma.operator.updateMany.mockResolvedValue({ count: 0 });
    prisma.operator.update.mockResolvedValue({ failedLoginCount: 1 });

    await denied(service.login('op@example.com', 'wrong'));

    expect(prisma.operator.update).toHaveBeenCalledTimes(1);
    expect(prisma.operator.update).toHaveBeenCalledWith({
      where: { id: 'op_1' },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.auth.login',
        success: false,
      }),
    );
  });

  it('邮箱不存在：同样 401，且仍然做一次密码哈希比较', async () => {
    const { service, prisma, audit } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(null);
    const argon =
      jest.requireActual<typeof import('../auth/password')>('../auth/password');
    const spy = jest.spyOn(argon, 'verifyPassword');

    await denied(service.login('nobody@example.com', 'whatever'));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(prisma.operator.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'OPERATOR', id: 'nobody@example.com' },
        success: false,
      }),
    );
    spy.mockRestore();
  });

  it('第 5 次失败：锁定 15 分钟并记 admin.auth.locked', async () => {
    const { service, prisma, audit } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({ failedLoginCount: 4 }),
    );
    prisma.operator.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.operator.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.operator.update.mockResolvedValueOnce({ failedLoginCount: 5 });

    const before = Date.now();
    await denied(service.login('op@example.com', 'wrong'));

    const lockCall = prisma.operator.updateMany.mock.calls[1][0] as {
      where: { id: string };
      data: { lockedUntil: Date };
    };
    expect(lockCall.where.id).toBe('op_1');
    const lockMs = lockCall.data.lockedUntil.getTime() - before;
    expect(lockMs).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(lockMs).toBeLessThanOrEqual(15 * 60_000 + 5000);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'OPERATOR', id: 'op@example.com' },
        action: 'admin.auth.locked',
        targetType: 'Operator',
        targetId: 'op_1',
      }),
    );
  });

  it('第 5 次失败时别的并发请求已先锁定：不重复写 locked 审计', async () => {
    const { service, prisma, audit } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({ failedLoginCount: 4 }),
    );
    prisma.operator.updateMany.mockResolvedValue({ count: 0 });
    prisma.operator.update.mockResolvedValueOnce({ failedLoginCount: 6 });

    await denied(service.login('op@example.com', 'wrong'));

    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.auth.locked' }),
    );
  });

  it('锁定期内：正确密码也拒绝，且不再累加计数', async () => {
    const { service, prisma } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 600_000),
      }),
    );

    await denied(service.login('op@example.com', 'correct-password'));

    expect(prisma.operator.update).not.toHaveBeenCalled();
    expect(prisma.operator.updateMany).not.toHaveBeenCalled();
  });

  it('锁定过期后：正确密码可以登录', async () => {
    const { service, prisma } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
      }),
    );

    const session = await service.login('op@example.com', 'correct-password');

    expect(session.accessToken).toEqual(expect.any(String));
    expect(prisma.operator.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { failedLoginCount: 0, lockedUntil: null },
      }),
    );
  });

  it('锁定过期后再输错一次：从 1 重新计数，不是立刻再锁', async () => {
    const { service, prisma } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
      }),
    );
    prisma.operator.updateMany.mockResolvedValue({ count: 1 });

    await denied(service.login('op@example.com', 'wrong'));

    expect(prisma.operator.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.operator.updateMany).toHaveBeenCalledWith({
      where: { id: 'op_1', lockedUntil: { lte: expect.any(Date) } },
      data: { failedLoginCount: 1, lockedUntil: null },
    });
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('已停用的运营：即使密码正确也 401，且不计数', async () => {
    const { service, prisma } = await buildService();
    prisma.operator.findUnique.mockResolvedValue(
      await buildOperator({ status: 'DISABLED' }),
    );

    await denied(service.login('op@example.com', 'correct-password'));

    expect(prisma.operator.update).not.toHaveBeenCalled();
    expect(prisma.operator.updateMany).not.toHaveBeenCalled();
  });
});
