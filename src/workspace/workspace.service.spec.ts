import { BadGatewayException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceStatus } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LabsClient } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceService } from './workspace.service';

function buildPrisma() {
  return {
    enrollment: { findUnique: jest.fn() },
    workspace: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  };
}

async function buildService(
  overrides: {
    prisma?: ReturnType<typeof buildPrisma>;
    labsClient?: any;
    gateway?: any;
    audit?: any;
    env?: Partial<Env>;
  } = {},
) {
  const prisma = overrides.prisma ?? buildPrisma();
  const labsClient = overrides.labsClient ?? { createVm: jest.fn(), stopVm: jest.fn(), startVm: jest.fn() };
  const gateway = overrides.gateway ?? { broadcastStatus: jest.fn() };
  const audit = overrides.audit ?? { record: jest.fn() };
  const env = { WORKSPACE_IDLE_TIMEOUT_MINUTES: 15, ...overrides.env };

  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkspaceService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: LabsClient, useValue: labsClient },
      { provide: WorkspaceGateway, useValue: gateway },
      { provide: ENV, useValue: env },
    ],
  }).compile();
  return { service: moduleRef.get(WorkspaceService), prisma, labsClient, gateway, audit };
}

const ENROLLMENT = { id: 'enr_1', userId: 'user_1', courseId: 'course_1', active: true };

describe('WorkspaceService.getForEnrollment', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.getForEnrollment('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.getForEnrollment('user_1', 'enr_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('CREATING 超过 5 分钟视为过期，标记 ERROR', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stale = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      createdAt: new Date(Date.now() - 6 * 60 * 1000),
    };
    prisma.workspace.findUnique.mockResolvedValue(stale);
    prisma.workspace.update.mockResolvedValue({ ...stale, status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' });

    const result = await service.getForEnrollment('user_1', 'enr_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' },
    });
    expect(result.status).toBe(WorkspaceStatus.ERROR);
  });

  it('CREATING 未超过 5 分钟时原样返回，不改状态', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const fresh = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.CREATING, createdAt: new Date() };
    prisma.workspace.findUnique.mockResolvedValue(fresh);

    const result = await service.getForEnrollment('user_1', 'enr_1');

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(result).toBe(fresh);
  });
});

describe('WorkspaceService.create', () => {
  it('已有非 ERROR 状态的 workspace 时直接返回，不重新创建', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const existing = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING };
    prisma.workspace.findUnique.mockResolvedValue(existing);

    const result = await service.create('user_1', 'enr_1');

    expect(result).toBe(existing);
    expect(labsClient.createVm).not.toHaveBeenCalled();
    expect(prisma.workspace.upsert).not.toHaveBeenCalled();
  });

  it('没有 workspace 时创建 CREATING 记录并立刻返回（不等 Labs）', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    const created = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.CREATING };
    prisma.workspace.upsert.mockResolvedValue(created);
    labsClient.createVm.mockReturnValue(new Promise(() => {})); // 故意挂起，模拟还没返回

    const result = await service.create('user_1', 'enr_1');

    expect(result).toBe(created);
    expect(prisma.workspace.upsert).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1' },
      update: { status: WorkspaceStatus.CREATING, errorMessage: null },
      create: { enrollmentId: 'enr_1', status: WorkspaceStatus.CREATING },
    });
  });
});

describe('WorkspaceService.provisionInBackground', () => {
  it('Labs 创建成功：落库 RUNNING、写审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    labsClient.createVm.mockResolvedValue({ labId: 'ws_1', username: 'learner', rdpPort: 3389 });
    const updated = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING };
    prisma.workspace.update.mockResolvedValue(updated);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: {
        status: WorkspaceStatus.RUNNING,
        labId: 'ws_1',
        rdpUsername: 'learner',
        rdpPort: 3389,
        errorMessage: null,
        lastSeenAt: expect.any(Date),
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.create', success: true, targetId: 'ws_1' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
  });

  it('Labs 失败：落库 ERROR、写失败审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    labsClient.createVm.mockRejectedValue(new Error('Labs 创建 VM 失败（504）：Command timed out after 180 seconds.'));
    const updated = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.ERROR,
      errorMessage: 'Labs 创建 VM 失败（504）：Command timed out after 180 seconds.',
    };
    prisma.workspace.update.mockResolvedValue(updated);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: {
        status: WorkspaceStatus.ERROR,
        errorMessage: 'Labs 创建 VM 失败（504）：Command timed out after 180 seconds.',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.create', success: false, targetId: 'ws_1' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
  });
});

describe('WorkspaceService.createConsoleSession', () => {
  function buildLabsClient() {
    return {
      createVm: jest.fn(),
      createBrowserSession: jest.fn().mockResolvedValue({
        labId: 'ws_1',
        state: 'ready',
        data: 'encrypted-ticket',
        expiresAt: '2026-08-24T00:05:00.000Z',
      }),
    };
  }

  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService({ labsClient: buildLabsClient() });
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService({ labsClient: buildLabsClient() });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('workspace 状态不是 RUNNING 时拒绝，不调用 Labs', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      labId: null,
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toThrow(ConflictException);
    expect(labsClient.createBrowserSession).not.toHaveBeenCalled();
  });

  it('Labs 调用失败时抛出 BadGatewayException，写失败审计', async () => {
    const labsClient = buildLabsClient();
    labsClient.createBrowserSession.mockRejectedValue(new Error('Labs 创建浏览器会话失败（502）：boom'));
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.console-session', success: false, targetId: 'ws_1' }),
    );
  });

  it('state=starting 时透传结果，不写审计', async () => {
    const labsClient = buildLabsClient();
    labsClient.createBrowserSession.mockResolvedValue({ labId: 'ws_1', state: 'starting' });
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    const result = await service.createConsoleSession('user_1', 'enr_1');

    expect(result).toEqual({ labId: 'ws_1', state: 'starting' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('state=ready 时透传 data/expiresAt，写成功审计', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    const result = await service.createConsoleSession('user_1', 'enr_1');

    expect(result).toEqual({
      labId: 'ws_1',
      state: 'ready',
      data: 'encrypted-ticket',
      expiresAt: '2026-08-24T00:05:00.000Z',
    });
    expect(labsClient.createBrowserSession).toHaveBeenCalledWith('ws_1', 'user_1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.console-session', success: true, targetId: 'ws_1' }),
    );
  });
});

describe('WorkspaceService.exchangeConsoleToken', () => {
  function buildLabsClient() {
    return {
      createVm: jest.fn(),
      exchangeGuacamoleToken: jest.fn().mockResolvedValue({
        authToken: 'real-auth-token',
        websocketUrl: 'wss://tunnel.trycloudflare.com/guacamole/websocket-tunnel',
      }),
    };
  }

  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService({ labsClient: buildLabsClient() });
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.exchangeConsoleToken('user_1', 'enr_1', 'encrypted-ticket')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('转发票据给 LabsClient，原样返回 authToken/websocketUrl', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);

    const result = await service.exchangeConsoleToken('user_1', 'enr_1', 'encrypted-ticket');

    expect(result).toEqual({
      authToken: 'real-auth-token',
      websocketUrl: 'wss://tunnel.trycloudflare.com/guacamole/websocket-tunnel',
    });
    expect(labsClient.exchangeGuacamoleToken).toHaveBeenCalledWith('encrypted-ticket');
  });

  it('LabsClient 失败时抛出 BadGatewayException', async () => {
    const labsClient = buildLabsClient();
    labsClient.exchangeGuacamoleToken.mockRejectedValue(
      new Error('Guacamole 换取 authToken 失败（403）：Permission Denied.'),
    );
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);

    await expect(service.exchangeConsoleToken('user_1', 'enr_1', 'bad-ticket')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('WorkspaceService.stop', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.stop('user_1', 'enr_1', 'manual')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.stop('user_1', 'enr_1', 'manual')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('workspace 不是 RUNNING 时幂等返回现状，不调用 Labs', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.STOPPED, labId: 'ws_1' };
    prisma.workspace.findUnique.mockResolvedValue(stopped);

    const result = await service.stop('user_1', 'enr_1', 'manual');

    expect(result).toBe(stopped);
    expect(labsClient.stopVm).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('RUNNING 时调用 Labs 停止、落库 STOPPED、写审计（带 reason）、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING, labId: 'lab_1' };
    prisma.workspace.findUnique.mockResolvedValue(running);
    labsClient.stopVm.mockResolvedValue(undefined);
    const updated = { ...running, status: WorkspaceStatus.STOPPED };
    prisma.workspace.update.mockResolvedValue(updated);

    const result = await service.stop('user_1', 'enr_1', 'beacon');

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.stop', success: true, targetId: 'ws_1', reason: 'beacon' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
    expect(result).toBe(updated);
  });

  it('Labs 停止失败时抛出 BadGatewayException，写失败审计，不改库里的状态', async () => {
    const { service, prisma, labsClient, audit } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING, labId: 'lab_1' };
    prisma.workspace.findUnique.mockResolvedValue(running);
    labsClient.stopVm.mockRejectedValue(new Error('Labs 停止 VM 失败（502）：boom'));

    await expect(service.stop('user_1', 'enr_1', 'manual')).rejects.toBeInstanceOf(BadGatewayException);

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.stop', success: false, targetId: 'ws_1', reason: 'manual' }),
    );
  });
});

describe('WorkspaceService.start', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('workspace 不是 STOPPED 时幂等返回现状，不调用 Labs', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING, labId: 'ws_1' };
    prisma.workspace.findUnique.mockResolvedValue(running);

    const result = await service.start('user_1', 'enr_1');

    expect(result).toBe(running);
    expect(labsClient.startVm).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('STOPPED 时调用 Labs 启动、落库 RUNNING 并刷新 lastSeenAt、写审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.STOPPED, labId: 'lab_1' };
    prisma.workspace.findUnique.mockResolvedValue(stopped);
    labsClient.startVm.mockResolvedValue(undefined);
    const updated = { ...stopped, status: WorkspaceStatus.RUNNING, lastSeenAt: new Date() };
    prisma.workspace.update.mockResolvedValue(updated);

    const result = await service.start('user_1', 'enr_1');

    expect(labsClient.startVm).toHaveBeenCalledWith('lab_1');
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { status: WorkspaceStatus.RUNNING, lastSeenAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.start', success: true, targetId: 'ws_1' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
    expect(result).toBe(updated);
  });

  it('Labs 启动失败时抛出 BadGatewayException，写失败审计', async () => {
    const { service, prisma, labsClient, audit } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.STOPPED, labId: 'lab_1' };
    prisma.workspace.findUnique.mockResolvedValue(stopped);
    labsClient.startVm.mockRejectedValue(new Error('Labs 启动 VM 失败（504）：boom'));

    await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.start', success: false, targetId: 'ws_1' }),
    );
  });
});

describe('WorkspaceService.heartbeat', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.heartbeat('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.heartbeat('user_1', 'enr_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('RUNNING 时刷新 lastSeenAt', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING };
    prisma.workspace.findUnique.mockResolvedValue(running);
    const updated = { ...running, lastSeenAt: new Date() };
    prisma.workspace.update.mockResolvedValue(updated);

    const result = await service.heartbeat('user_1', 'enr_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { lastSeenAt: expect.any(Date) },
    });
    expect(result).toBe(updated);
  });

  it('非 RUNNING 时不更新，原样返回现状', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.STOPPED };
    prisma.workspace.findUnique.mockResolvedValue(stopped);

    const result = await service.heartbeat('user_1', 'enr_1');

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(result).toBe(stopped);
  });
});

describe('WorkspaceService.sweepIdle', () => {
  it('查询 RUNNING 且 lastSeenAt 早于超时阈值的 workspace', async () => {
    const { service, prisma } = await buildService({ env: { WORKSPACE_IDLE_TIMEOUT_MINUTES: 15 } });
    prisma.workspace.findMany.mockResolvedValue([]);

    const before = Date.now();
    await service.sweepIdle();
    const after = Date.now();

    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.workspace.findMany.mock.calls[0][0];
    expect(call.where.status).toBe(WorkspaceStatus.RUNNING);
    const [nullBranch, thresholdBranch] = call.where.OR as Array<Record<string, unknown>>;
    expect(nullBranch).toEqual({ lastSeenAt: null });
    const threshold = (thresholdBranch.lastSeenAt as { lt: Date }).lt;
    expect(threshold.getTime()).toBeGreaterThanOrEqual(before - 15 * 60 * 1000 - 1000);
    expect(threshold.getTime()).toBeLessThanOrEqual(after - 15 * 60 * 1000 + 1000);
  });

  it('lastSeenAt 为 NULL（迁移前就存在的 workspace，从未写过心跳）的也当作空闲处理', async () => {
    // NULL < threshold 在 SQL 里恒为 NULL 不是 true，光用 lt 查询会让这些 workspace 永远扫不到、
    // 永远不会被停掉——用显式的 OR lastSeenAt IS NULL 补上这个缺口。
    const { service, prisma, labsClient } = await buildService();
    const neverHeartbeated = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING, labId: 'lab_1', lastSeenAt: null };
    prisma.workspace.findMany.mockResolvedValue([neverHeartbeated]);
    labsClient.stopVm.mockResolvedValue(undefined);
    prisma.workspace.update.mockResolvedValue({ ...neverHeartbeated, status: WorkspaceStatus.STOPPED });

    await service.sweepIdle();

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
  });

  it('命中的每个 workspace 都调用 Labs 停止、落库 STOPPED、写系统审计（reason=idle）、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    const idle1 = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING, labId: 'lab_1' };
    const idle2 = { id: 'ws_2', enrollmentId: 'enr_2', status: WorkspaceStatus.RUNNING, labId: 'lab_2' };
    prisma.workspace.findMany.mockResolvedValue([idle1, idle2]);
    labsClient.stopVm.mockResolvedValue(undefined);
    prisma.workspace.update
      .mockResolvedValueOnce({ ...idle1, status: WorkspaceStatus.STOPPED })
      .mockResolvedValueOnce({ ...idle2, status: WorkspaceStatus.STOPPED });

    await service.sweepIdle();

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_2');
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_2' },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.stop', success: true, targetId: 'ws_1', reason: 'idle' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledTimes(2);
  });

  it('某个 workspace 停止失败不影响其它 workspace 继续处理', async () => {
    const { service, prisma, labsClient } = await buildService();
    const idle1 = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING, labId: 'lab_1' };
    const idle2 = { id: 'ws_2', enrollmentId: 'enr_2', status: WorkspaceStatus.RUNNING, labId: 'lab_2' };
    prisma.workspace.findMany.mockResolvedValue([idle1, idle2]);
    labsClient.stopVm.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    prisma.workspace.update.mockResolvedValue({ ...idle2, status: WorkspaceStatus.STOPPED });

    await expect(service.sweepIdle()).resolves.toBeUndefined();

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_2');
  });
});
