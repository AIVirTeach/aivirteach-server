import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TOKEN_AUDIENCE_ADMIN, signAccessToken } from '../auth/tokens';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuthGuard, type OperatorRequest } from './operator-auth.guard';

const SECRET = 'a'.repeat(48);

const buildGuard = async () => {
  const prisma = { operator: { findUnique: jest.fn() } };
  const moduleRef = await Test.createTestingModule({
    providers: [
      OperatorAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: { JWT_SECRET: SECRET } },
    ],
  }).compile();
  return { guard: moduleRef.get(OperatorAuthGuard), prisma };
};

const contextFor = (request: Partial<OperatorRequest>) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const bearer = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
});
const operatorToken = (ttl = '8h') =>
  signAccessToken(
    { sub: 'op_1', email: 'token@example.com' },
    SECRET,
    ttl,
    TOKEN_AUDIENCE_ADMIN,
  );
const activeOperator = (overrides = {}) => ({
  id: 'op_1',
  email: 'op@example.com',
  status: 'ACTIVE',
  passwordChangedAt: new Date(Date.now() - 3_600_000),
  ...overrides,
});

describe('OperatorAuthGuard', () => {
  it('没有 Authorization 头 → 401', async () => {
    const { guard } = await buildGuard();

    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('不是 Bearer 格式、乱码、过期的令牌 → 401', async () => {
    const { guard, prisma } = await buildGuard();
    prisma.operator.findUnique.mockResolvedValue(activeOperator());
    const expired = await signAccessToken(
      { sub: 'op_1', email: 'op@example.com' },
      SECRET,
      '0s',
      TOKEN_AUDIENCE_ADMIN,
    );

    for (const request of [
      { headers: { authorization: 'Basic abc' } },
      bearer('not.a.jwt'),
      bearer(expired),
    ]) {
      await expect(
        guard.canActivate(contextFor(request)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('学员令牌（audience 不符）→ 401，且不查库', async () => {
    const { guard, prisma } = await buildGuard();
    const learnerToken = await signAccessToken(
      { sub: 'user_1', email: 'learner@example.com' },
      SECRET,
      '15m',
    );

    await expect(
      guard.canActivate(contextFor(bearer(learnerToken))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.operator.findUnique).not.toHaveBeenCalled();
  });

  it('令牌有效但运营已停用 → 401', async () => {
    const { guard, prisma } = await buildGuard();
    prisma.operator.findUnique.mockResolvedValue(
      activeOperator({ status: 'DISABLED' }),
    );

    await expect(
      guard.canActivate(contextFor(bearer(await operatorToken()))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('令牌签发时间早于最近一次改密码 → 401', async () => {
    const { guard, prisma } = await buildGuard();
    const token = await operatorToken();
    prisma.operator.findUnique.mockResolvedValue(
      activeOperator({ passwordChangedAt: new Date(Date.now() + 60_000) }),
    );

    await expect(
      guard.canActivate(contextFor(bearer(token))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('改密码和签发发生在同一秒：令牌仍然有效（按秒比较）', async () => {
    const { guard, prisma } = await buildGuard();
    const token = await operatorToken();
    prisma.operator.findUnique.mockResolvedValue(
      activeOperator({ passwordChangedAt: new Date() }),
    );

    await expect(guard.canActivate(contextFor(bearer(token)))).resolves.toBe(
      true,
    );
  });

  it('令牌里的运营已被删除 → 401', async () => {
    const { guard, prisma } = await buildGuard();
    prisma.operator.findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor(bearer(await operatorToken()))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ACTIVE 且令牌合格 → 放行，并把库里的 id 和邮箱放到 request.operator', async () => {
    const { guard, prisma } = await buildGuard();
    prisma.operator.findUnique.mockResolvedValue(activeOperator());
    const request: Partial<OperatorRequest> = bearer(await operatorToken());

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request.operator).toEqual({ id: 'op_1', email: 'op@example.com' });
    expect(prisma.operator.findUnique).toHaveBeenCalledWith({
      where: { id: 'op_1' },
      select: {
        id: true,
        email: true,
        status: true,
        passwordChangedAt: true,
      },
    });
  });
});
