import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { LabsClient } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceService } from './workspace.service';

function buildPrisma() {
  return {
    enrollment: { findUnique: jest.fn() },
    workspace: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
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
  const labsClient = overrides.labsClient ?? { createVm: jest.fn() };
  const gateway = overrides.gateway ?? { broadcastStatus: jest.fn() };
  const audit = overrides.audit ?? { record: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkspaceService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: LabsClient, useValue: labsClient },
      { provide: WorkspaceGateway, useValue: gateway },
      { provide: ENV, useValue: { LABS_CONSOLE_WS_URL: 'wss://labs-console.test', ...overrides.env } },
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
      getCredentials: jest.fn().mockResolvedValue({ password: 'secret-pw' }),
      registerConsoleToken: jest.fn().mockResolvedValue(undefined),
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
      rdpUsername: null,
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toThrow(ConflictException);
    expect(labsClient.registerConsoleToken).not.toHaveBeenCalled();
    expect(labsClient.getCredentials).not.toHaveBeenCalled();
  });

  it('LABS_CONSOLE_WS_URL 未配置时抛出 ServiceUnavailableException，不调用 Labs', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient, env: { LABS_CONSOLE_WS_URL: undefined } });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(labsClient.registerConsoleToken).not.toHaveBeenCalled();
    expect(labsClient.getCredentials).not.toHaveBeenCalled();
  });

  it('Labs 登记 token 失败时抛出 BadGatewayException，不透出内部错误信息', async () => {
    const labsClient = buildLabsClient();
    labsClient.registerConsoleToken.mockRejectedValue(new Error('Labs 登记 console token 失败（502）：boom'));
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(labsClient.getCredentials).not.toHaveBeenCalled();
  });

  it('Labs 取密码失败时抛出 BadGatewayException', async () => {
    const labsClient = buildLabsClient();
    labsClient.getCredentials.mockRejectedValue(new Error('Labs 获取凭据失败（404）：boom'));
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('RUNNING 时：登记 token、取密码、组装返回值', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    const result = await service.createConsoleSession('user_1', 'enr_1');

    expect(result.rdpUsername).toBe('learner');
    expect(result.rdpPassword).toBe('secret-pw');
    expect(result.wsUrl).toMatch(/^wss:\/\/labs-console\.test\/\?token=/);
    expect(labsClient.registerConsoleToken).toHaveBeenCalledWith('ws_1', expect.any(String), 300);
    expect(labsClient.getCredentials).toHaveBeenCalledWith('ws_1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.console-session', success: true, targetId: 'ws_1' }),
    );
  });
});
