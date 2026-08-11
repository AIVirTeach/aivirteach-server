import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { hashOpaqueToken, verifyAccessToken } from './tokens';

const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: 'a'.repeat(48),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
  CORS_ORIGINS: 'tauri://localhost',
};

const future = () => new Date(Date.now() + 3_600_000);
const past = () => new Date(Date.now() - 3_600_000);

type PrismaStub = {
  user: { findUnique: jest.Mock; update: jest.Mock };
  invitation: { findUnique: jest.Mock; update: jest.Mock };
  refreshToken: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

const buildPrisma = (): PrismaStub => ({
  user: { findUnique: jest.fn(), update: jest.fn() },
  invitation: { findUnique: jest.fn(), update: jest.fn() },
  refreshToken: {
    findUnique: jest.fn(),
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: { tokenHash: string } }) =>
        Promise.resolve({ id: `rt_${data.tokenHash.slice(0, 6)}`, ...data }),
      ),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
});

const buildService = async (prisma: PrismaStub, audit = { record: jest.fn() }) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(AuthService), audit };
};

describe('AuthService.login', () => {
  it('凭证正确时返回可验签的 access token 和不透明 refresh token', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'ACTIVE',
    });
    const { service, audit } = await buildService(prisma);

    const pair = await service.login('learner@example.com', 'correct-password');

    await expect(
      verifyAccessToken(pair.accessToken, ENV_STUB.JWT_SECRET),
    ).resolves.toEqual({
      sub: 'user_1',
      email: 'learner@example.com',
    });
    // expiresIn 描述的是 access token 的寿命（15m=900s），不是 refresh token 的 30 天
    expect(pair.expiresIn).toBe(15 * 60);
    expect(pair.refreshToken).not.toContain('.');
    // 落库的必须是哈希，不能是明文
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenHash: hashOpaqueToken(pair.refreshToken),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'USER', id: 'user_1' },
        action: 'auth.login',
        success: true,
      }),
    );
  });

  it('密码错误时抛 UnauthorizedException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'ACTIVE',
    });
    const { service } = await buildService(prisma);

    await expect(
      service.login('learner@example.com', 'wrong'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('用户不存在与密码错误的报错信息完全一致（防账号枚举）', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(
      service.login('nobody@example.com', 'whatever'),
    ).rejects.toThrow('凭证无效');
  });

  it('用户被停用时拒绝登录', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'SUSPENDED',
    });
    const { service } = await buildService(prisma);

    await expect(
      service.login('learner@example.com', 'correct-password'),
    ).rejects.toThrow('凭证无效');
  });
});

describe('AuthService.acceptInvitation', () => {
  it('有效邀请码会设置密码、激活账号并发 token', async () => {
    const prisma = buildPrisma();
    prisma.invitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      expiresAt: future(),
      acceptedAt: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'INVITED' },
    });
    prisma.user.update.mockResolvedValue({});
    const { service } = await buildService(prisma);

    const pair = await service.acceptInvitation(
      'plain-invite-token',
      'new-password-123',
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(prisma.invitation.update).toHaveBeenCalled();
    await expect(
      verifyAccessToken(pair.accessToken, ENV_STUB.JWT_SECRET),
    ).resolves.toEqual({
      sub: 'user_1',
      email: 'learner@example.com',
    });
  });

  it('邀请码已被用过时拒绝', async () => {
    const prisma = buildPrisma();
    prisma.invitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      expiresAt: future(),
      acceptedAt: new Date(),
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const { service } = await buildService(prisma);

    await expect(
      service.acceptInvitation('used-token', 'pw-12345678'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('邀请码过期时拒绝', async () => {
    const prisma = buildPrisma();
    prisma.invitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      expiresAt: past(),
      acceptedAt: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'INVITED' },
    });
    const { service } = await buildService(prisma);

    await expect(
      service.acceptInvitation('expired', 'pw-12345678'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.refresh', () => {
  it('有效 refresh token 会轮换：旧的被撤销并指向新的', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt_old',
      userId: 'user_1',
      expiresAt: future(),
      revokedAt: null,
      replacedBy: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const { service, audit } = await buildService(prisma);

    const pair = await service.refresh('old-plain-token');

    expect(pair.refreshToken).toBeDefined();
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt_old' },
        data: expect.objectContaining({ replacedBy: expect.any(String) }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh', success: true }),
    );
  });

  it('重放已撤销的 token 会撤销该用户整个 token 家族', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt_old',
      userId: 'user_1',
      expiresAt: future(),
      revokedAt: new Date(),
      replacedBy: 'rt_new',
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const { service } = await buildService(prisma);

    await expect(service.refresh('replayed-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user_1' }),
      }),
    );
  });

  it('不存在的 refresh token 被拒绝', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(service.refresh('nonexistent')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService.logout', () => {
  it('撤销指定的 refresh token', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt_1',
      userId: 'user_1',
      expiresAt: future(),
      revokedAt: null,
      replacedBy: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const { service, audit } = await buildService(prisma);

    await service.logout('plain-token');

    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt_1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', success: true }),
    );
  });

  it('登出一个不存在的 token 不报错（幂等）', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    const { service, audit } = await buildService(prisma);

    await expect(service.logout('nonexistent')).resolves.toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
