import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceStatus } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LabsClient } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceService } from './workspace.service';

function buildPrisma() {
  const prisma = {
    enrollment: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workspace: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    workspaceProvision: {
      create: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ createSettled: true }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return {
    ...prisma,
    $transaction: jest.fn((fn: (tx: typeof prisma) => unknown) =>
      Promise.resolve(fn(prisma)),
    ),
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
  const labsClient = overrides.labsClient ?? {
    createVm: jest.fn(),
    deleteVm: jest.fn(),
    stopVm: jest.fn(),
    startVm: jest.fn(),
    getVmState: jest.fn(),
  };
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
  return {
    service: moduleRef.get(WorkspaceService),
    prisma,
    labsClient,
    gateway,
    audit,
  };
}

const ENROLLMENT = {
  id: 'enr_1',
  userId: 'user_1',
  courseId: 'course_1',
  active: true,
  generation: 0,
};

describe('WorkspaceService.getForEnrollment', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(
      service.getForEnrollment('user_1', 'enr_1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(
      service.getForEnrollment('user_1', 'enr_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    prisma.workspace.findUnique
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({
        ...stale,
        status: WorkspaceStatus.ERROR,
        errorMessage: '创建超时，请重试',
      });
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.getForEnrollment('user_1', 'enr_1');

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ws_1',
        status: WorkspaceStatus.CREATING,
        provisionGeneration: 0,
      },
      data: { status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' },
    });
    expect(result.status).toBe(WorkspaceStatus.ERROR);
  });

  it('超时判定与 restart 并发时保留 RESETTING 状态', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stale = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      createdAt: new Date(Date.now() - 6 * 60 * 1000),
    };
    prisma.workspace.findUnique
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ ...stale, status: WorkspaceStatus.RESETTING });
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.getForEnrollment('user_1', 'enr_1')).resolves.toEqual(
      expect.objectContaining({ status: WorkspaceStatus.RESETTING }),
    );
  });

  it('CREATING 未超过 5 分钟时原样返回，不改状态', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const fresh = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      createdAt: new Date(),
    };
    prisma.workspace.findUnique.mockResolvedValue(fresh);

    const result = await service.getForEnrollment('user_1', 'enr_1');

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(result).toBe(fresh);
  });

  it('旧工作区重建时按本轮开始时间判断超时', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const retrying = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      provisionStartedAt: new Date(),
    };
    prisma.workspace.findUnique.mockResolvedValue(retrying);

    await expect(service.getForEnrollment('user_1', 'enr_1')).resolves.toBe(
      retrying,
    );
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.create', () => {
  it('restart 后 enrollment 未激活时不创建新的 VM', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      active: false,
    });

    await expect(service.create('user_1', 'enr_1')).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.workspace.create).not.toHaveBeenCalled();
    expect(labsClient.createVm).not.toHaveBeenCalled();
  });

  it('已有非 ERROR 状态的 workspace 时直接返回，不重新创建', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const existing = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
    };
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
    const created = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
    };
    prisma.workspace.create.mockResolvedValue(created);
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    labsClient.createVm.mockReturnValue(new Promise(() => {})); // 故意挂起，模拟还没返回

    const result = await service.create('user_1', 'enr_1');

    expect(result).toBe(created);
    expect(prisma.workspaceProvision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        labId: 'ws_1',
        workspaceId: 'ws_1',
        generation: 0,
      }),
    });
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: {
        enrollmentId: 'enr_1',
        status: WorkspaceStatus.CREATING,
        provisionStartedAt: expect.any(Date),
      },
    });
  });

  it('创建记录后才发生 restart 时，把它转为 RESETTING 而不启动 VM', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.enrollment.updateMany.mockResolvedValue({ count: 0 });
    prisma.workspace.findUnique.mockResolvedValue(null);
    prisma.workspace.create.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
    });
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspace.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'ws_1',
        enrollmentId: 'enr_1',
        status: WorkspaceStatus.RESETTING,
      });

    await expect(service.create('user_1', 'enr_1')).resolves.toEqual(
      expect.objectContaining({ status: WorkspaceStatus.RESETTING }),
    );

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ws_1',
        status: WorkspaceStatus.CREATING,
        provisionGeneration: 0,
      },
      data: {
        status: WorkspaceStatus.RESETTING,
        provisionStartedAt: null,
        resetRetryAt: null,
      },
    });
    expect(labsClient.createVm).not.toHaveBeenCalled();
  });

  it('旧 create 遇到 restart 后重新 enroll，不能为旧工作区预约 VM', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT); // Old generation 0 snapshot.
    prisma.enrollment.updateMany.mockResolvedValue({ count: 0 }); // DB is active at generation 1.
    prisma.workspace.findUnique.mockResolvedValue(null); // Restart removed the old row.
    prisma.workspace.create.mockResolvedValue({
      id: 'old_ws',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      provisionGeneration: 0,
    });

    await expect(service.create('user_1', 'enr_1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr_1', generation: 0, active: true },
      data: { active: true },
    });
    expect(prisma.workspaceProvision.create).not.toHaveBeenCalled();
    expect(labsClient.createVm).not.toHaveBeenCalled();
  });

  it('预约前工作区已被替换时返回新行，不创建旧 VM', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const replacement = {
      id: 'new_ws',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      provisionGeneration: 0,
    };
    prisma.workspace.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replacement);
    prisma.workspace.create.mockResolvedValue({
      id: 'old_ws',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      provisionGeneration: 0,
    });
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.create('user_1', 'enr_1')).resolves.toBe(replacement);
    expect(prisma.workspaceProvision.create).not.toHaveBeenCalled();
    expect(labsClient.createVm).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.provisionInBackground', () => {
  it('旧创建晚于重试完成时，不能覆盖新 VM', async () => {
    const { service, prisma, labsClient } = await buildService();
    let finishOld!: (value: {
      labId: string;
      username: string;
      rdpPort: number;
    }) => void;
    labsClient.createVm.mockImplementation((labId: string) =>
      labId === 'ws_1'
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({ labId, username: 'new', rdpPort: 3389 }),
    );
    prisma.workspace.updateMany.mockImplementation(({ where }) =>
      Promise.resolve({ count: where.provisionGeneration === 1 ? 1 : 0 }),
    );
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      status: WorkspaceStatus.RUNNING,
    });
    labsClient.deleteVm.mockResolvedValue(undefined);

    const old = service.provisionInBackground('ws_1', 'user_1', 0, 'ws_1');
    await service.provisionInBackground('ws_1', 'user_1', 1, 'ws_1-1');
    finishOld({ labId: 'ws_1', username: 'old', rdpPort: 3389 });
    await old;

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'ws_1',
          status: WorkspaceStatus.CREATING,
          provisionGeneration: 1,
        },
        data: expect.objectContaining({ labId: 'ws_1-1' }),
      }),
    );
    expect(labsClient.deleteVm).toHaveBeenCalledWith('ws_1');
    expect(labsClient.deleteVm).not.toHaveBeenCalledWith('ws_1-1');
  });

  it('旧请求失败时不能把新一轮创建标记 ERROR', async () => {
    const { service, prisma, labsClient } = await buildService();
    labsClient.createVm.mockRejectedValue(new Error('old timeout'));
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    await service.provisionInBackground('ws_1', 'user_1', 0, 'ws_1');
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'ws_1',
          status: WorkspaceStatus.CREATING,
          provisionGeneration: 0,
        },
      }),
    );
  });

  it('迟到 VM 删除失败后保留清理记录，下一轮扫描重试', async () => {
    const { service, prisma, labsClient } = await buildService();
    labsClient.createVm.mockResolvedValue({
      labId: 'ws_1',
      username: 'old',
      rdpPort: 3389,
    });
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    labsClient.deleteVm
      .mockRejectedValueOnce(new Error('Labs unavailable'))
      .mockResolvedValue(undefined);

    await expect(
      service.provisionInBackground('ws_1', 'user_1'),
    ).rejects.toThrow('Labs unavailable');
    expect(prisma.workspaceProvision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { labId: 'ws_1', status: 'CLEANUP' },
        data: expect.objectContaining({
          status: 'CLEANUP',
          cleanupAt: expect.any(Date),
        }),
      }),
    );
    prisma.workspace.findMany.mockResolvedValue([]);
    prisma.workspaceProvision.findMany.mockResolvedValue([{ labId: 'ws_1' }]);
    await expect(service.sweepResets()).resolves.toEqual({
      attempted: 1,
      failed: 0,
    });
    expect(labsClient.deleteVm).toHaveBeenCalledTimes(2);
    expect(prisma.workspaceProvision.deleteMany).toHaveBeenCalledWith({
      where: { labId: 'ws_1', status: 'CLEANUP' },
    });
  });

  it('创建结果未知时，即使当前 VM 不存在也保留墓碑并继续扫描', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.workspace.findMany.mockResolvedValue([]);
    prisma.workspaceProvision.findMany.mockResolvedValue([{ labId: 'ws_1' }]);
    prisma.workspaceProvision.findUnique.mockResolvedValue({
      createSettled: false,
    });
    labsClient.deleteVm.mockResolvedValue(undefined); // Labs currently reports VM missing.

    await expect(service.sweepResets()).resolves.toEqual({
      attempted: 1,
      failed: 0,
    });
    expect(prisma.workspaceProvision.deleteMany).not.toHaveBeenCalled();
    expect(prisma.workspaceProvision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { labId: 'ws_1', status: 'CLEANUP' },
        data: { status: 'CLEANUP', cleanupAt: expect.any(Date) },
      }),
    );

    // The delayed create appears later; the next sweep still has its cleanup key.
    await service.sweepResets();
    expect(labsClient.deleteVm).toHaveBeenCalledTimes(2);
  });

  it('清理开始后创建响应才到达，也不能绑定已清理的 VM', async () => {
    const { service, prisma, labsClient } = await buildService();
    let finishCreate!: (value: {
      labId: string;
      username: string;
      rdpPort: number;
    }) => void;
    labsClient.createVm.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    labsClient.deleteVm.mockResolvedValue(undefined);
    prisma.workspace.findMany.mockResolvedValue([]);
    prisma.workspaceProvision.findMany.mockResolvedValue([{ labId: 'ws_1' }]);
    prisma.workspaceProvision.findUnique.mockResolvedValue({
      createSettled: false,
    });
    prisma.workspaceProvision.updateMany
      .mockResolvedValueOnce({ count: 1 }) // PENDING -> CLEANUP
      .mockResolvedValueOnce({ count: 1 }) // unknown result: remain CLEANUP
      .mockResolvedValueOnce({ count: 1 }) // create response settles
      .mockResolvedValueOnce({ count: 0 }); // cannot claim CLEANUP before retryAt
    prisma.workspaceProvision.deleteMany.mockResolvedValue({ count: 0 }); // attach requires PENDING

    const creating = service.provisionInBackground('ws_1', 'user_1');
    await service.sweepResets();
    finishCreate({ labId: 'ws_1', username: 'learner', rdpPort: 3389 });
    await creating;

    expect(prisma.workspace.updateMany).not.toHaveBeenCalled();
    expect(prisma.workspaceProvision.deleteMany).toHaveBeenCalledWith({
      where: { labId: 'ws_1', status: 'PENDING' },
    });
    expect(prisma.workspaceProvision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { labId: 'ws_1', status: 'CLEANUP' },
        data: { status: 'CLEANUP', cleanupAt: expect.any(Date) },
      }),
    );
  });

  it('Labs 创建成功：落库 RUNNING、写审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } =
      await buildService();
    labsClient.createVm.mockResolvedValue({
      labId: 'ws_1',
      username: 'learner',
      rdpPort: 3389,
    });
    const updated = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
    };
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspace.findUnique.mockResolvedValue(updated);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ws_1',
        status: WorkspaceStatus.CREATING,
        provisionGeneration: 0,
      },
      data: {
        status: WorkspaceStatus.RUNNING,
        provisionStartedAt: null,
        labId: 'ws_1',
        rdpUsername: 'learner',
        rdpPort: 3389,
        errorMessage: null,
        lastSeenAt: expect.any(Date),
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.create',
        success: true,
        targetId: 'ws_1',
      }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
  });

  it('Labs 失败：落库 ERROR、写失败审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } =
      await buildService();
    labsClient.createVm.mockRejectedValue(
      new Error('学习环境暂时连接不上，请稍后重试。'),
    );
    const updated = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.ERROR,
      errorMessage: '学习环境暂时连接不上，请稍后重试。',
    };
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspace.findUnique.mockResolvedValue(updated);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ws_1',
        status: WorkspaceStatus.CREATING,
        provisionGeneration: 0,
      },
      data: {
        status: WorkspaceStatus.ERROR,
        errorMessage: '学习环境暂时连接不上，请稍后重试。',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.create',
        success: false,
        targetId: 'ws_1',
      }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
  });

  it('restart 已把 workspace 设为 RESETTING 时，迟到的创建结果不复活旧环境', async () => {
    const { service, prisma, labsClient, gateway } = await buildService();
    labsClient.createVm.mockResolvedValue({
      labId: 'ws_1',
      username: 'learner',
      rdpPort: 3389,
    });
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    labsClient.deleteVm.mockResolvedValue(undefined);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'ws_1',
          status: WorkspaceStatus.CREATING,
          provisionGeneration: 0,
        },
      }),
    );
    expect(labsClient.deleteVm).toHaveBeenCalledWith('ws_1');
    expect(gateway.broadcastStatus).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.finishReset', () => {
  it('先确认旧 VM 已删除，再移除 RESETTING 记录', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      labId: 'lab_1',
      status: WorkspaceStatus.RESETTING,
    });
    labsClient.deleteVm.mockResolvedValue(undefined);
    prisma.workspace.deleteMany.mockResolvedValue({ count: 1 });

    await service.finishReset('enr_1');

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1' },
    });
    expect(labsClient.deleteVm).toHaveBeenCalledWith('lab_1');
    expect(prisma.workspace.deleteMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.RESETTING },
    });
    expect(labsClient.deleteVm.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.workspace.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('VM 删除失败时保留 RESETTING 记录供重试', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      labId: null,
      status: WorkspaceStatus.RESETTING,
      updatedAt: new Date(Date.now() - 201_000),
    });
    labsClient.deleteVm.mockRejectedValue(new Error('Labs unavailable'));

    await expect(service.finishReset('enr_1')).rejects.toThrow(
      'Labs unavailable',
    );

    expect(labsClient.deleteVm).toHaveBeenCalledWith('ws_1');
    expect(prisma.workspace.deleteMany).not.toHaveBeenCalled();
  });

  it('创建 VM 尚未返回时保留 RESETTING 任务，待旧请求结束后再删', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      labId: 'old_lab_1',
      status: WorkspaceStatus.RESETTING,
      provisionStartedAt: new Date(),
    });

    await expect(service.finishReset('enr_1')).resolves.toBe(false);
    expect(labsClient.deleteVm).not.toHaveBeenCalled();
    expect(prisma.workspace.deleteMany).not.toHaveBeenCalled();
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { resetRetryAt: expect.any(Date) } }),
    );
  });
});

describe('WorkspaceService.sweepResets', () => {
  it('前十条清理持续失败时，下次扫描仍能处理第十一条', async () => {
    const { service, prisma, labsClient } = await buildService();
    const rows = Array.from({ length: 11 }, (_, index) => ({
      id: `ws_${index}`,
      enrollmentId: `enr_${index}`,
      labId: `lab_${index}`,
      status: WorkspaceStatus.RESETTING,
      updatedAt: new Date(index * 1000),
      resetRetryAt: null as Date | null,
    }));
    prisma.workspace.findMany.mockImplementation(({ take }: { take: number }) =>
      Promise.resolve(
        rows
          .filter((row) => !row.resetRetryAt || row.resetRetryAt <= new Date())
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
          .slice(0, take),
      ),
    );
    prisma.workspace.findUnique.mockImplementation(
      ({ where }: { where: { enrollmentId: string } }) =>
        Promise.resolve(
          rows.find((row) => row.enrollmentId === where.enrollmentId),
        ),
    );
    prisma.workspace.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: { resetRetryAt: Date };
      }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (row) {
          row.resetRetryAt = data.resetRetryAt;
          row.updatedAt = new Date();
        }
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    );
    labsClient.deleteVm.mockImplementation((labId: string) =>
      labId === 'lab_10'
        ? Promise.resolve()
        : Promise.reject(new Error('Labs unavailable')),
    );
    prisma.workspace.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.sweepResets()).resolves.toEqual({
      attempted: 10,
      failed: 10,
    });
    await expect(service.sweepResets()).resolves.toEqual({
      attempted: 1,
      failed: 0,
    });
    expect(labsClient.deleteVm).toHaveBeenCalledWith('lab_10');
  });

  it('一个清理失败仍继续处理其它待清理 workspace，并保留失败记录', async () => {
    const { service, prisma, labsClient } = await buildService();
    const pending = [
      {
        id: 'ws_1',
        enrollmentId: 'enr_1',
        labId: 'lab_1',
        status: WorkspaceStatus.RESETTING,
      },
      {
        id: 'ws_2',
        enrollmentId: 'enr_2',
        labId: 'lab_2',
        status: WorkspaceStatus.RESETTING,
      },
    ];
    prisma.workspace.findMany.mockResolvedValue(pending);
    prisma.workspace.findUnique.mockImplementation(
      ({ where }: { where: { enrollmentId: string } }) =>
        Promise.resolve(
          pending.find((item) => item.enrollmentId === where.enrollmentId),
        ),
    );
    labsClient.deleteVm
      .mockRejectedValueOnce(new Error('Labs unavailable'))
      .mockResolvedValueOnce(undefined);
    prisma.workspace.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.sweepResets()).resolves.toEqual({
      attempted: 2,
      failed: 1,
    });

    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      where: {
        status: WorkspaceStatus.RESETTING,
        OR: [
          { resetRetryAt: null },
          { resetRetryAt: { lte: expect.any(Date) } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 10,
    });
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ws_1', status: WorkspaceStatus.RESETTING },
        data: { resetRetryAt: expect.any(Date) },
      }),
    );
    expect(prisma.workspace.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.workspace.deleteMany).toHaveBeenCalledWith({
      where: { id: 'ws_2', status: WorkspaceStatus.RESETTING },
    });
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
    const { service, prisma } = await buildService({
      labsClient: buildLabsClient(),
    });
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(
      service.createConsoleSession('user_1', 'enr_1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService({
      labsClient: buildLabsClient(),
    });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(
      service.createConsoleSession('user_1', 'enr_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
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

    await expect(
      service.createConsoleSession('user_1', 'enr_1'),
    ).rejects.toThrow(ConflictException);
    expect(labsClient.createBrowserSession).not.toHaveBeenCalled();
  });

  it('Labs 调用失败时抛出 BadGatewayException，写失败审计', async () => {
    const labsClient = buildLabsClient();
    labsClient.createBrowserSession.mockRejectedValue(
      new Error('Labs 创建浏览器会话失败（502）：boom'),
    );
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    await expect(
      service.createConsoleSession('user_1', 'enr_1'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.console-session',
        success: false,
        targetId: 'ws_1',
      }),
    );
  });

  it('state=starting 时透传结果，不写审计', async () => {
    const labsClient = buildLabsClient();
    labsClient.createBrowserSession.mockResolvedValue({
      labId: 'ws_1',
      state: 'starting',
    });
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
    expect(labsClient.createBrowserSession).toHaveBeenCalledWith(
      'ws_1',
      'user_1',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.console-session',
        success: true,
        targetId: 'ws_1',
      }),
    );
  });
});

describe('WorkspaceService.exchangeConsoleToken', () => {
  function buildLabsClient() {
    return {
      createVm: jest.fn(),
      exchangeGuacamoleToken: jest.fn().mockResolvedValue({
        authToken: 'real-auth-token',
        websocketUrl:
          'wss://tunnel.trycloudflare.com/guacamole/websocket-tunnel',
      }),
    };
  }

  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService({
      labsClient: buildLabsClient(),
    });
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(
      service.exchangeConsoleToken('user_1', 'enr_1', 'encrypted-ticket'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('转发票据给 LabsClient，原样返回 authToken/websocketUrl', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
    });

    const result = await service.exchangeConsoleToken(
      'user_1',
      'enr_1',
      'encrypted-ticket',
    );

    expect(result).toEqual({
      authToken: 'real-auth-token',
      websocketUrl: 'wss://tunnel.trycloudflare.com/guacamole/websocket-tunnel',
    });
    expect(labsClient.exchangeGuacamoleToken).toHaveBeenCalledWith(
      'encrypted-ticket',
    );
  });

  it('LabsClient 失败时抛出 BadGatewayException', async () => {
    const labsClient = buildLabsClient();
    labsClient.exchangeGuacamoleToken.mockRejectedValue(
      new Error('Guacamole 换取 authToken 失败（403）：Permission Denied.'),
    );
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
    });

    await expect(
      service.exchangeConsoleToken('user_1', 'enr_1', 'bad-ticket'),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('restart 待清理时拒绝兑换旧控制台票据', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RESETTING,
    });

    await expect(
      service.exchangeConsoleToken('user_1', 'enr_1', 'old-ticket'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(labsClient.exchangeGuacamoleToken).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.stop', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(
      service.stop('user_1', 'enr_1', 'manual'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(
      service.stop('user_1', 'enr_1', 'manual'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('workspace 不是 RUNNING 时幂等返回现状，不调用 Labs', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.STOPPED,
      labId: 'ws_1',
    };
    prisma.workspace.findUnique.mockResolvedValue(stopped);

    const result = await service.stop('user_1', 'enr_1', 'manual');

    expect(result).toBe(stopped);
    expect(labsClient.stopVm).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('RUNNING 时调用 Labs 停止、落库 STOPPED、写审计（带 reason）、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } =
      await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
    };
    const updated = { ...running, status: WorkspaceStatus.STOPPED };
    prisma.workspace.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(updated);
    labsClient.stopVm.mockResolvedValue(undefined);
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.stop('user_1', 'enr_1', 'beacon');

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.RUNNING },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.stop',
        success: true,
        targetId: 'ws_1',
        reason: 'beacon',
      }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
    expect(result).toBe(updated);
  });

  it('restart 已开始时，迟到的 stop 不把 RESETTING 改回 STOPPED', async () => {
    const { service, prisma, labsClient, gateway } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
    };
    const resetting = { ...running, status: WorkspaceStatus.RESETTING };
    prisma.workspace.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(resetting);
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    labsClient.stopVm.mockResolvedValue(undefined);

    await expect(service.stop('user_1', 'enr_1', 'manual')).resolves.toBe(
      resetting,
    );

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.RUNNING },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(gateway.broadcastStatus).not.toHaveBeenCalled();
  });

  it('Labs 停止失败时抛出 BadGatewayException，写失败审计，不改库里的状态', async () => {
    const { service, prisma, labsClient, audit } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
    };
    prisma.workspace.findUnique.mockResolvedValue(running);
    labsClient.stopVm.mockRejectedValue(
      new Error('Labs 停止 VM 失败（502）：boom'),
    );

    await expect(
      service.stop('user_1', 'enr_1', 'manual'),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.stop',
        success: false,
        targetId: 'ws_1',
        reason: 'manual',
      }),
    );
  });

  // stop 失败时不从错误码猜 VM 状态，而是再问一次 Labs 真实状态，按观察结果决定。
  describe('stop 失败后按 Labs 的真实状态对账', () => {
    const running = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
    };

    async function setup() {
      const ctx = await buildService();
      ctx.prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
      ctx.prisma.workspace.findUnique.mockResolvedValue(running);
      ctx.labsClient.stopVm.mockRejectedValue(
        new Error('学习环境暂时无法使用，请稍后再试或联系客服。'),
      );
      return ctx;
    }

    it('VM 其实已经关机：落库 STOPPED，按成功处理', async () => {
      const { service, prisma, labsClient, audit, gateway } = await setup();
      labsClient.getVmState.mockResolvedValue({
        kind: 'present',
        state: 'shut off',
      });
      const updated = { ...running, status: WorkspaceStatus.STOPPED };
      prisma.workspace.findUnique
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(updated);
      prisma.workspace.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.stop('user_1', 'enr_1', 'manual')).resolves.toBe(
        updated,
      );

      expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
        where: { id: 'ws_1', status: WorkspaceStatus.RUNNING },
        data: { status: WorkspaceStatus.STOPPED },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workspace.stop',
          success: true,
          metadata: { vmState: 'shut off' },
        }),
      );
      expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
    });

    it('Labs 确认 VM 不存在：落库 ERROR（用户可重新创建），审计标记 vmMissing，不抛错', async () => {
      const { service, prisma, labsClient, audit, gateway } = await setup();
      labsClient.getVmState.mockResolvedValue({ kind: 'missing' });
      const updated = { ...running, status: WorkspaceStatus.ERROR };
      prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
      prisma.workspace.findUnique
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(updated);

      await expect(service.stop('user_1', 'enr_1', 'manual')).resolves.toBe(
        updated,
      );

      expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
        where: { id: 'ws_1', status: WorkspaceStatus.RUNNING },
        data: {
          status: WorkspaceStatus.ERROR,
          errorMessage: '学习环境已失效，请重新创建。',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workspace.stop',
          success: false,
          metadata: { vmMissing: true },
        }),
      );
      expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
    });

    it.each(['running', 'in shutdown', 'paused', 'crashed'])(
      'VM 状态为 %s：保持 RUNNING，抛 BadGatewayException，失败审计里带上观察到的状态',
      async (state) => {
        const { service, prisma, labsClient, audit } = await setup();
        labsClient.getVmState.mockResolvedValue({ kind: 'present', state });

        await expect(
          service.stop('user_1', 'enr_1', 'manual'),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(prisma.workspace.update).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'workspace.stop',
            success: false,
            metadata: { vmState: state },
          }),
        );
      },
    );

    it('状态也查不到（如 403 鉴权故障）：保持 RUNNING，抛 BadGatewayException，留给下一轮 sweep 重试', async () => {
      const { service, prisma, labsClient, audit } = await setup();
      labsClient.getVmState.mockRejectedValue(
        new Error('学习环境暂时无法使用，请稍后再试或联系客服。'),
      );

      await expect(
        service.stop('user_1', 'enr_1', 'manual'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(prisma.workspace.update).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workspace.stop',
          success: false,
          metadata: { vmState: 'unknown' },
        }),
      );
    });
  });
});

describe('WorkspaceService.start', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('workspace 不是 STOPPED 时幂等返回现状，不调用 Labs', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    };
    prisma.workspace.findUnique.mockResolvedValue(running);

    const result = await service.start('user_1', 'enr_1');

    expect(result).toBe(running);
    expect(labsClient.startVm).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('STOPPED 时调用 Labs 启动、落库 RUNNING 并刷新 lastSeenAt、写审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } =
      await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.STOPPED,
      labId: 'lab_1',
    };
    const updated = {
      ...stopped,
      status: WorkspaceStatus.RUNNING,
      lastSeenAt: new Date(),
    };
    prisma.workspace.findUnique
      .mockResolvedValueOnce(stopped)
      .mockResolvedValueOnce(updated);
    labsClient.startVm.mockResolvedValue(undefined);
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.start('user_1', 'enr_1');

    expect(labsClient.startVm).toHaveBeenCalledWith('lab_1');
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.STOPPED },
      data: { status: WorkspaceStatus.RUNNING, lastSeenAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.start',
        success: true,
        targetId: 'ws_1',
      }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
    expect(result).toBe(updated);
  });

  it('restart 已开始时，迟到的 start 不把 RESETTING 改回 RUNNING', async () => {
    const { service, prisma, labsClient, gateway } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.STOPPED,
      labId: 'lab_1',
    };
    const resetting = { ...stopped, status: WorkspaceStatus.RESETTING };
    prisma.workspace.findUnique
      .mockResolvedValueOnce(stopped)
      .mockResolvedValueOnce(resetting);
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    labsClient.startVm.mockResolvedValue(undefined);

    await expect(service.start('user_1', 'enr_1')).resolves.toBe(resetting);

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.STOPPED },
      data: { status: WorkspaceStatus.RUNNING, lastSeenAt: expect.any(Date) },
    });
    expect(gateway.broadcastStatus).not.toHaveBeenCalled();
  });

  it('Labs 启动失败时抛出 BadGatewayException，写失败审计', async () => {
    const { service, prisma, labsClient, audit } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stopped = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.STOPPED,
      labId: 'lab_1',
    };
    prisma.workspace.findUnique.mockResolvedValue(stopped);
    labsClient.startVm.mockRejectedValue(
      new Error('Labs 启动 VM 失败（504）：boom'),
    );

    await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.start',
        success: false,
        targetId: 'ws_1',
      }),
    );
  });

  describe('start 失败后按 Labs 的真实状态对账', () => {
    const stopped = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.STOPPED,
      labId: 'ws_1',
    };

    async function setup() {
      const ctx = await buildService();
      ctx.prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
      ctx.prisma.workspace.findUnique.mockResolvedValue(stopped);
      ctx.labsClient.startVm.mockRejectedValue(
        new Error('学习环境暂时无法使用，请稍后再试或联系客服。'),
      );
      return ctx;
    }

    it('Labs 确认 VM 已不存在：自动重建——落库 CREATING、后台重新创建、写 vmMissing 审计、广播，不抛错', async () => {
      const { service, prisma, labsClient, audit, gateway } = await setup();
      labsClient.getVmState.mockResolvedValue({ kind: 'missing' });
      labsClient.createVm.mockReturnValue(new Promise(() => {})); // 挂起，模拟重建还没返回
      const rebuilding = {
        ...stopped,
        status: WorkspaceStatus.CREATING,
        errorMessage: null,
        provisionGeneration: 1,
      };
      prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
      prisma.workspace.findUnique
        .mockResolvedValueOnce(stopped)
        .mockResolvedValueOnce(rebuilding);

      await expect(service.start('user_1', 'enr_1')).resolves.toBe(rebuilding);

      expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
        where: { id: 'ws_1', status: WorkspaceStatus.STOPPED },
        data: {
          status: WorkspaceStatus.CREATING,
          errorMessage: null,
          provisionStartedAt: expect.any(Date),
          provisionGeneration: { increment: 1 },
        },
      });
      expect(labsClient.createVm).toHaveBeenCalledWith('ws_1-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workspace.start',
          success: false,
          targetId: 'ws_1',
          metadata: { vmMissing: true },
        }),
      );
      expect(gateway.broadcastStatus).toHaveBeenCalledWith(rebuilding);
    });

    it('restart 已开始时不重建缺失的旧 VM', async () => {
      const { service, prisma, labsClient, gateway } = await setup();
      const resetting = { ...stopped, status: WorkspaceStatus.RESETTING };
      prisma.workspace.findUnique
        .mockResolvedValueOnce(stopped)
        .mockResolvedValueOnce(resetting);
      prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
      labsClient.getVmState.mockResolvedValue({ kind: 'missing' });

      await expect(service.start('user_1', 'enr_1')).resolves.toBe(resetting);

      expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
        where: { id: 'ws_1', status: WorkspaceStatus.STOPPED },
        data: {
          status: WorkspaceStatus.CREATING,
          errorMessage: null,
          provisionStartedAt: expect.any(Date),
          provisionGeneration: { increment: 1 },
        },
      });
      expect(labsClient.createVm).not.toHaveBeenCalled();
      expect(gateway.broadcastStatus).not.toHaveBeenCalled();
    });

    it('VM 还在（只是启动失败）：不重建，照常抛 BadGatewayException', async () => {
      const { service, prisma, labsClient } = await setup();
      labsClient.getVmState.mockResolvedValue({
        kind: 'present',
        state: 'shut off',
      });

      await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(
        BadGatewayException,
      );

      expect(labsClient.createVm).not.toHaveBeenCalled();
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });

    it('对账本身也失败（状态未知）：不重建，照常抛 BadGatewayException', async () => {
      const { service, prisma, labsClient } = await setup();
      labsClient.getVmState.mockRejectedValue(new Error('网络故障'));

      await expect(service.start('user_1', 'enr_1')).rejects.toBeInstanceOf(
        BadGatewayException,
      );

      expect(labsClient.createVm).not.toHaveBeenCalled();
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });
  });
});

describe('WorkspaceService.heartbeat', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({
      ...ENROLLMENT,
      userId: 'someone_else',
    });
    await expect(service.heartbeat('user_1', 'enr_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.heartbeat('user_1', 'enr_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('RUNNING 时刷新 lastSeenAt', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const running = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
    };
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
    const stopped = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.STOPPED,
    };
    prisma.workspace.findUnique.mockResolvedValue(stopped);

    const result = await service.heartbeat('user_1', 'enr_1');

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(result).toBe(stopped);
  });
});

describe('WorkspaceService.sweepIdle', () => {
  it('查询 RUNNING 且 lastSeenAt 早于超时阈值的 workspace', async () => {
    const { service, prisma } = await buildService({
      env: { WORKSPACE_IDLE_TIMEOUT_MINUTES: 15 },
    });
    prisma.workspace.findMany.mockResolvedValue([]);

    const before = Date.now();
    await service.sweepIdle();
    const after = Date.now();

    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.workspace.findMany.mock.calls[0][0];
    expect(call.where.status).toBe(WorkspaceStatus.RUNNING);
    const [nullBranch, thresholdBranch] = call.where.OR as Array<
      Record<string, unknown>
    >;
    expect(nullBranch).toEqual({ lastSeenAt: null });
    const threshold = (thresholdBranch.lastSeenAt as { lt: Date }).lt;
    expect(threshold.getTime()).toBeGreaterThanOrEqual(
      before - 15 * 60 * 1000 - 1000,
    );
    expect(threshold.getTime()).toBeLessThanOrEqual(
      after - 15 * 60 * 1000 + 1000,
    );
  });

  it('lastSeenAt 为 NULL（迁移前就存在的 workspace，从未写过心跳）的也当作空闲处理', async () => {
    // NULL < threshold 在 SQL 里恒为 NULL 不是 true，光用 lt 查询会让这些 workspace 永远扫不到、
    // 永远不会被停掉——用显式的 OR lastSeenAt IS NULL 补上这个缺口。
    const { service, prisma, labsClient } = await buildService();
    const neverHeartbeated = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
      lastSeenAt: null,
    };
    prisma.workspace.findMany.mockResolvedValue([neverHeartbeated]);
    labsClient.stopVm.mockResolvedValue(undefined);
    prisma.workspace.update.mockResolvedValue({
      ...neverHeartbeated,
      status: WorkspaceStatus.STOPPED,
    });

    await service.sweepIdle();

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
  });

  it('命中的每个 workspace 都调用 Labs 停止、落库 STOPPED、写系统审计（reason=idle）、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } =
      await buildService();
    const idle1 = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
    };
    const idle2 = {
      id: 'ws_2',
      enrollmentId: 'enr_2',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_2',
    };
    prisma.workspace.findMany.mockResolvedValue([idle1, idle2]);
    labsClient.stopVm.mockResolvedValue(undefined);
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspace.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({
          ...(where.id === 'ws_1' ? idle1 : idle2),
          status: WorkspaceStatus.STOPPED,
        }),
    );

    await service.sweepIdle();

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_2');
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.RUNNING },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_2', status: WorkspaceStatus.RUNNING },
      data: { status: WorkspaceStatus.STOPPED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.stop',
        success: true,
        targetId: 'ws_1',
        reason: 'idle',
      }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledTimes(2);
  });

  it('VM 已不存在的 workspace 落库 ERROR，不再被下一轮 sweep 命中（sweepIdle 每分钟重试的根因修复）', async () => {
    const { service, prisma, labsClient } = await buildService();
    const orphaned = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_gone',
    };
    prisma.workspace.findMany.mockResolvedValue([orphaned]);
    labsClient.stopVm.mockRejectedValue(
      new Error('学习环境暂时无法使用，请稍后再试或联系客服。'),
    );
    labsClient.getVmState.mockResolvedValue({ kind: 'missing' });
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspace.findUnique.mockResolvedValue({
      ...orphaned,
      status: WorkspaceStatus.ERROR,
    });

    await expect(service.sweepIdle()).resolves.toBeUndefined();

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws_1', status: WorkspaceStatus.RUNNING },
      data: {
        status: WorkspaceStatus.ERROR,
        errorMessage: '学习环境已失效，请重新创建。',
      },
    });
  });

  it('某个 workspace 停止失败不影响其它 workspace 继续处理', async () => {
    const { service, prisma, labsClient } = await buildService();
    const idle1 = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_1',
    };
    const idle2 = {
      id: 'ws_2',
      enrollmentId: 'enr_2',
      status: WorkspaceStatus.RUNNING,
      labId: 'lab_2',
    };
    prisma.workspace.findMany.mockResolvedValue([idle1, idle2]);
    labsClient.stopVm
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    prisma.workspace.update.mockResolvedValue({
      ...idle2,
      status: WorkspaceStatus.STOPPED,
    });

    await expect(service.sweepIdle()).resolves.toBeUndefined();

    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_1');
    expect(labsClient.stopVm).toHaveBeenCalledWith('lab_2');
  });
});
