jest.mock('../auth/tokens');

import { Test } from '@nestjs/testing';
import { ENV, type Env } from '../config/env';
import { verifyAccessToken } from '../auth/tokens';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGateway } from './workspace.gateway';

const mockedVerify = verifyAccessToken as jest.MockedFunction<typeof verifyAccessToken>;

const BASE_ENV: Env = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'x'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 4000,
  CORS_ORIGINS: 'http://localhost:3001',
};

function buildSocket() {
  return { readyState: 1, OPEN: 1, send: jest.fn(), close: jest.fn(), on: jest.fn() } as any;
}

function buildPrisma() {
  return { enrollment: { findUnique: jest.fn() } };
}

async function buildGateway(prisma: ReturnType<typeof buildPrisma> = buildPrisma()) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkspaceGateway,
      { provide: ENV, useValue: BASE_ENV },
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { gateway: moduleRef.get(WorkspaceGateway), prisma };
}

describe('WorkspaceGateway', () => {
  afterEach(() => jest.resetAllMocks());

  it('缺少 token 或 enrollmentId 时直接关闭连接', async () => {
    const { gateway } = await buildGateway();
    const socket = buildSocket();
    await gateway.handleConnection(socket, { url: '/api/v1/workspaces/socket?enrollmentId=e1' } as any);
    expect(socket.close).toHaveBeenCalled();
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('token 无效时关闭连接', async () => {
    mockedVerify.mockRejectedValue(new Error('invalid'));
    const { gateway } = await buildGateway();
    const socket = buildSocket();
    await gateway.handleConnection(socket, { url: '/api/v1/workspaces/socket?token=bad&enrollmentId=e1' } as any);
    expect(socket.close).toHaveBeenCalled();
  });

  it('enrollment 不属于当前用户时以 4001 关闭连接，不建立订阅', async () => {
    mockedVerify.mockResolvedValue({ sub: 'user_1', email: 'a@b.com' });
    const prisma = buildPrisma();
    prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1', userId: 'someone_else' });
    const { gateway } = await buildGateway(prisma);
    const socket = buildSocket();

    await gateway.handleConnection(socket, { url: '/api/v1/workspaces/socket?token=good&enrollmentId=e1' } as any);

    expect(socket.close).toHaveBeenCalledWith(4001, '无权访问这个 enrollment');
    expect(socket.readyState).toBe(1);

    // 未订阅成功的连接不应收到该 enrollment 的广播
    gateway.broadcastStatus({ id: 'w1', enrollmentId: 'e1', status: 'RUNNING' } as any);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('enrollment 不存在时以 4001 关闭连接', async () => {
    mockedVerify.mockResolvedValue({ sub: 'user_1', email: 'a@b.com' });
    const prisma = buildPrisma();
    prisma.enrollment.findUnique.mockResolvedValue(null);
    const { gateway } = await buildGateway(prisma);
    const socket = buildSocket();

    await gateway.handleConnection(socket, { url: '/api/v1/workspaces/socket?token=good&enrollmentId=e1' } as any);

    expect(socket.close).toHaveBeenCalledWith(4001, '无权访问这个 enrollment');
  });

  it('token 有效且 enrollment 归属正确时按 enrollmentId 订阅，broadcastStatus 只推给匹配且拥有该 enrollment 的连接', async () => {
    mockedVerify.mockResolvedValue({ sub: 'user_1', email: 'a@b.com' });
    const prisma = buildPrisma();
    prisma.enrollment.findUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve({ id, userId: 'user_1' }),
    );
    const { gateway } = await buildGateway(prisma);
    const matching = buildSocket();
    const other = buildSocket();

    await gateway.handleConnection(matching, { url: '/api/v1/workspaces/socket?token=good&enrollmentId=e1' } as any);
    await gateway.handleConnection(other, { url: '/api/v1/workspaces/socket?token=good&enrollmentId=e2' } as any);

    const workspace = { id: 'w1', enrollmentId: 'e1', status: 'RUNNING' };
    gateway.broadcastStatus(workspace as any);

    expect(matching.send).toHaveBeenCalledWith(JSON.stringify({ type: 'workspace.status', workspace }));
    expect(other.send).not.toHaveBeenCalled();
    expect(matching.close).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });
});
