import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  Prisma,
  WorkspaceStatus,
  type Workspace,
} from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditActor } from '../audit/audit.service';
import {
  LabsClient,
  type BrowserSession,
  type GuacamoleToken,
  type VmState,
} from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';

const STALE_CREATING_MS = 5 * 60 * 1000;
// Labs 创建最多等待 180 秒，HTTP 客户端最多等待 200 秒；留 10 秒余量。
// 重启时不能因为此刻查不到 VM 就丢掉清理任务：旧 POST 可能仍在执行。
const CREATE_VM_SETTLE_MS = 210_000;
const RESET_RETRY_MS = 60_000;
const UNKNOWN_CREATE_RECHECK_MS = 60 * 60 * 1000;
class StaleProvisionError extends Error {}

export type ConsoleSessionResult = BrowserSession;
export type StopReason = 'manual' | 'beacon';
type InternalStopReason = StopReason | 'idle';

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly labsClient: LabsClient,
    private readonly gateway: WorkspaceGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async getForEnrollment(
    userId: string,
    enrollmentId: string,
  ): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');

    if (
      workspace.status === WorkspaceStatus.CREATING &&
      this.isStale(workspace)
    ) {
      await this.prisma.workspace.updateMany({
        where: {
          id: workspace.id,
          status: WorkspaceStatus.CREATING,
          provisionGeneration: workspace.provisionGeneration ?? 0,
        },
        data: {
          status: WorkspaceStatus.ERROR,
          errorMessage: '创建超时，请重试',
        },
      });
      const current = await this.prisma.workspace.findUnique({
        where: { id: workspace.id },
      });
      if (!current) throw new NotFoundException('没有找到这个课程的工作区');
      return current;
    }
    return workspace;
  }

  async createConsoleSession(
    userId: string,
    enrollmentId: string,
  ): Promise<ConsoleSessionResult> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.RUNNING) {
      throw new ConflictException('工作区还没准备好，请稍后再试');
    }

    let session: BrowserSession;
    try {
      session = await this.labsClient.createBrowserSession(
        workspace.labId!,
        userId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.console-session',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      throw new BadGatewayException(message);
    }

    // 只在真正建立会话（state === "ready"）时写审计；客户端每 2-3 秒轮询一次这个接口，
    // 中间的 "starting"/"unavailable" 响应不是有意义的审计事件，见 Global Constraints。
    if (session.state === 'ready') {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.console-session',
        success: true,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
    }

    return session;
  }

  // 浏览器不能直接跨域 fetch Guacamole 的 /api/tokens（CORS），这里由 server 转发一次；
  // enrollment 归属校验跟其它接口一致，票据本身的有效性交给 Guacamole/Labs 判断。
  async exchangeConsoleToken(
    userId: string,
    enrollmentId: string,
    data: string,
  ): Promise<GuacamoleToken> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!workspace || workspace.status !== WorkspaceStatus.RUNNING) {
      throw new ConflictException('工作区当前不可连接');
    }
    try {
      return await this.labsClient.exchangeGuacamoleToken(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      throw new BadGatewayException(message);
    }
  }

  async create(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    if (!enrollment.active) throw new ConflictException('请先开始课程');
    const existing = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });

    // 已经在建或已经好了：直接把现状交回去，不重复发起创建（DB 唯一约束也会挡，这里提前短路更省事）。
    if (existing && existing.status !== WorkspaceStatus.ERROR) return existing;

    let workspace: Workspace;
    if (existing) {
      const changed = await this.prisma.workspace.updateMany({
        where: { id: existing.id, status: WorkspaceStatus.ERROR },
        data: {
          status: WorkspaceStatus.CREATING,
          errorMessage: null,
          provisionStartedAt: new Date(),
          provisionGeneration: { increment: 1 },
        },
      });
      const current = await this.prisma.workspace.findUnique({
        where: { id: existing.id },
      });
      if (!current) throw new NotFoundException('没有找到这个课程的工作区');
      if (changed.count === 0 || current.status !== WorkspaceStatus.CREATING)
        return current;
      workspace = current;
    } else {
      try {
        workspace = await this.prisma.workspace.create({
          data: {
            enrollmentId: enrollment.id,
            status: WorkspaceStatus.CREATING,
            provisionStartedAt: new Date(),
          },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        )
          throw error;
        const current = await this.prisma.workspace.findUnique({
          where: { enrollmentId: enrollment.id },
        });
        if (!current) throw error;
        return current;
      }
    }

    // Labs 的 POST /v1/vms 最长阻塞 180 秒；用 waitUntil 在这次请求返回 202 之后继续跑，
    // 不让 client 裸等。函数实例中途被回收会丢掉这次后台任务——这是选这个简单方案接受的代价，
    // 靠 getForEnrollment 里的 5 分钟过期判断兜底，见本文档 Global Constraints。
    const scheduled = await this.scheduleProvision(
      workspace,
      userId,
      enrollment.generation,
    );
    if (scheduled) return workspace;
    const current = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!current) throw new ConflictException('工作区已重置，请重试');
    return current;
  }

  private async scheduleProvision(
    workspace: Workspace,
    userId: string,
    enrollmentGeneration: number,
  ): Promise<boolean> {
    const generation = workspace.provisionGeneration ?? 0;
    const labId =
      generation === 0 ? workspace.id : `${workspace.id}-${generation}`;
    const scheduled = await this.prisma.$transaction(async (tx) => {
      // Enrollment is the aggregate boundary: lock this generation before
      // reserving a VM, in the same order as restart (Enrollment -> Workspace).
      const currentEnrollment = await tx.enrollment.updateMany({
        where: {
          id: workspace.enrollmentId,
          generation: enrollmentGeneration,
          active: true,
        },
        data: { active: true },
      });
      if (currentEnrollment.count === 0) {
        await tx.workspace.updateMany({
          where: {
            id: workspace.id,
            status: WorkspaceStatus.CREATING,
            provisionGeneration: generation,
          },
          data: {
            status: WorkspaceStatus.RESETTING,
            provisionStartedAt: null,
            resetRetryAt: null,
          },
        });
        return false;
      }
      const currentWorkspace = await tx.workspace.updateMany({
        where: {
          id: workspace.id,
          status: WorkspaceStatus.CREATING,
          provisionGeneration: generation,
        },
        data: { status: WorkspaceStatus.CREATING },
      });
      if (currentWorkspace.count === 0) return false;
      await tx.workspaceProvision.create({
        data: {
          labId,
          workspaceId: workspace.id,
          generation,
          cleanupAt: new Date(Date.now() + CREATE_VM_SETTLE_MS),
        },
      });
      return true;
    });
    if (!scheduled) return false;
    waitUntil(
      this.provisionInBackground(workspace.id, userId, generation, labId).catch(
        (error: unknown) => {
          this.logger.error(
            `VM ${labId} 创建任务异常，保留清理记录等待重试`,
            error,
          );
        },
      ),
    );
    return true;
  }

  // 不是 private：测试直接调用它，绕开 waitUntil 的运行时行为。
  async provisionInBackground(
    workspaceId: string,
    userId: string,
    generation = 0,
    labId = workspaceId,
  ): Promise<void> {
    let result: Awaited<ReturnType<LabsClient['createVm']>>;
    try {
      result = await this.labsClient.createVm(labId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      const changed = await this.prisma.workspace.updateMany({
        where: {
          id: workspaceId,
          status: WorkspaceStatus.CREATING,
          provisionGeneration: generation,
        },
        data: { status: WorkspaceStatus.ERROR, errorMessage: message },
      });
      if (changed.count === 0) return;
      const updated = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!updated || updated.status !== WorkspaceStatus.ERROR) return;
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.create',
        success: false,
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      this.gateway.broadcastStatus(updated);
      return;
    }

    // A successful POST definitively settles this attempt. A timeout/error does not:
    // Labs may still be creating the VM after our HTTP request ends.
    await this.prisma.workspaceProvision.updateMany({
      where: { labId },
      data: { createSettled: true },
    });

    // restart 可以在 Labs 创建 VM 的 180 秒内发生。只能把仍处于 CREATING 的这一代
    // workspace 标成 RUNNING；旧创建任务完成后要删掉它的 VM，不能复活 RESETTING 记录。
    let changed: { count: number };
    try {
      changed = await this.prisma.$transaction(async (tx) => {
        // Claim the provision before attaching the VM. The sweeper claims the same row
        // before deletion, so attachment and cleanup cannot both win.
        const claimed = await tx.workspaceProvision.deleteMany({
          where: { labId, status: 'PENDING' },
        });
        if (claimed.count === 0) return { count: 0 };
        const updated = await tx.workspace.updateMany({
          where: {
            id: workspaceId,
            status: WorkspaceStatus.CREATING,
            provisionGeneration: generation,
          },
          data: {
            status: WorkspaceStatus.RUNNING,
            provisionStartedAt: null,
            labId: result.labId,
            rdpUsername: result.username,
            rdpPort: result.rdpPort,
            errorMessage: null,
            lastSeenAt: new Date(),
          },
        });
        if (updated.count === 0) {
          // Roll back the claim so the stale VM remains discoverable for cleanup.
          throw new StaleProvisionError();
        }
        return updated;
      });
    } catch (error) {
      if (!(error instanceof StaleProvisionError)) throw error;
      await this.cleanupProvision(labId);
      return;
    }
    if (changed.count === 0) {
      // The provision row predates the POST and survives a failed DELETE.
      await this.cleanupProvision(labId);
      return;
    }
    const updated = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!updated || updated.status !== WorkspaceStatus.RUNNING) return;
    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'workspace.create',
      success: true,
      targetType: 'Workspace',
      targetId: workspaceId,
    });
    this.gateway.broadcastStatus(updated);
  }

  private async cleanupProvision(labId: string): Promise<void> {
    const claimed = await this.prisma.workspaceProvision.updateMany({
      where: {
        labId,
        OR: [
          { status: 'PENDING' },
          { status: 'CLEANUP', cleanupAt: { lte: new Date() } },
        ],
      },
      data: {
        status: 'CLEANUP',
        cleanupAt: new Date(Date.now() + RESET_RETRY_MS),
      },
    });
    if (claimed.count === 0) return;
    try {
      const provision = await this.prisma.workspaceProvision.findUnique({
        where: { labId },
      });
      await this.labsClient.deleteVm(labId);
      if (provision?.createSettled) {
        await this.prisma.workspaceProvision.deleteMany({
          where: { labId, status: 'CLEANUP' },
        });
      } else {
        // A missing VM is only a snapshot while the POST result is unknown.
        // Keep the tombstone so a later VM is found and deleted.
        await this.prisma.workspaceProvision.updateMany({
          where: { labId, status: 'CLEANUP' },
          data: {
            status: 'CLEANUP',
            cleanupAt: new Date(Date.now() + UNKNOWN_CREATE_RECHECK_MS),
          },
        });
      }
    } catch (error) {
      await this.prisma.workspaceProvision.updateMany({
        where: { labId, status: 'CLEANUP' },
        data: {
          status: 'CLEANUP',
          cleanupAt: new Date(Date.now() + RESET_RETRY_MS),
        },
      });
      throw error;
    }
  }

  // RESETTING 行本身是持久的清理任务。Labs 删除未确认前保留 labId 和记录，
  // 这样请求结束、函数被回收或 Labs 暂时失败后仍能重试。
  async finishReset(enrollmentId: string): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId },
    });
    if (!workspace || workspace.status !== WorkspaceStatus.RESETTING)
      return true;
    if (
      workspace.provisionStartedAt &&
      Date.now() - workspace.provisionStartedAt.getTime() < CREATE_VM_SETTLE_MS
    ) {
      await this.prisma.workspace.updateMany({
        where: { id: workspace.id, status: WorkspaceStatus.RESETTING },
        data: {
          resetRetryAt: new Date(
            workspace.provisionStartedAt.getTime() + CREATE_VM_SETTLE_MS,
          ),
        },
      });
      return false;
    }

    try {
      await this.labsClient.deleteVm(workspace.labId ?? workspace.id);
      await this.prisma.workspace.deleteMany({
        where: { id: workspace.id, status: WorkspaceStatus.RESETTING },
      });
      await this.audit.record({
        actor: { type: AuditActorType.SYSTEM },
        action: 'workspace.reset',
        success: true,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      return true;
    } catch (error) {
      await this.prisma.workspace.updateMany({
        where: { id: workspace.id, status: WorkspaceStatus.RESETTING },
        data: { resetRetryAt: new Date(Date.now() + RESET_RETRY_MS) },
      });
      await this.audit.record({
        actor: { type: AuditActorType.SYSTEM },
        action: 'workspace.reset',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      throw error;
    }
  }

  async sweepResets(): Promise<{ attempted: number; failed: number }> {
    const pending = await this.prisma.workspace.findMany({
      where: {
        status: WorkspaceStatus.RESETTING,
        OR: [{ resetRetryAt: null }, { resetRetryAt: { lte: new Date() } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: 10,
    });
    let failed = 0;
    for (const workspace of pending) {
      try {
        await this.finishReset(workspace.enrollmentId);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `workspace ${workspace.id} 重置未完成：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const provisions = await this.prisma.workspaceProvision.findMany({
      where: { cleanupAt: { lte: new Date() } },
      orderBy: { cleanupAt: 'asc' },
      take: 10,
    });
    for (const provision of provisions) {
      try {
        await this.cleanupProvision(provision.labId);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `VM ${provision.labId} 清理未完成：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { attempted: pending.length + provisions.length, failed };
  }

  async stop(
    userId: string,
    enrollmentId: string,
    reason: StopReason,
  ): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    // 已经不是 RUNNING：可能是重复触发（beacon 打两次、关闭前先被空闲扫描停了），幂等返回现状。
    if (workspace.status !== WorkspaceStatus.RUNNING) return workspace;

    return this.stopWorkspace(
      workspace,
      { type: AuditActorType.USER, id: userId },
      reason,
    );
  }

  async start(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.STOPPED) return workspace;

    try {
      await this.labsClient.startVm(workspace.labId!);
    } catch (error) {
      // start 失败也不从错误码猜：再问一次 Labs 的真实状态，只有确认 VM 已不存在才重建；
      // 查询失败（鉴权、网络……）或 VM 还在，都保持原状并报错，不能因为一次故障就重建丢掉学生的环境。
      const observed = await this.observeVmState(workspace.labId!);
      if (observed?.kind === 'missing')
        return this.rebuildMissingVm(workspace, userId, enrollment.generation);

      const message = error instanceof Error ? error.message : '未知错误';
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.start',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      throw new BadGatewayException(message);
    }

    const changed = await this.prisma.workspace.updateMany({
      where: { id: workspace.id, status: WorkspaceStatus.STOPPED },
      data: { status: WorkspaceStatus.RUNNING, lastSeenAt: new Date() },
    });
    const updated = await this.prisma.workspace.findUnique({
      where: { id: workspace.id },
    });
    if (!updated) throw new NotFoundException('没有找到这个课程的工作区');
    if (changed.count === 0 || updated.status !== WorkspaceStatus.RUNNING)
      return updated;
    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'workspace.start',
      success: true,
      targetType: 'Workspace',
      targetId: workspace.id,
    });
    this.gateway.broadcastStatus(updated);
    return updated;
  }

  // 客户端每 60 秒调一次；只在 RUNNING 时刷新 lastSeenAt，供 sweepIdle 判断空闲用，
  // 不写审计——太频繁，不是有意义的审计事件（跟 console-session 轮询同样的取舍）。
  async heartbeat(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { enrollmentId: enrollment.id },
    });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.RUNNING) return workspace;

    return this.prisma.workspace.update({
      where: { id: workspace.id },
      data: { lastSeenAt: new Date() },
    });
  }

  // Plan B 兜底：关标签页时 sendBeacon 没送到（崩溃/断网）的情况下，靠这个把长期没心跳的
  // workspace 收掉。由全局 interceptor 搭便车调用（见 workspace.module.ts），不用 Vercel Cron
  // ——免费版 Cron 一天只能跑一次，覆盖不了分钟级的空闲检测。单个 workspace 停止失败不阻塞其它的。
  async sweepIdle(): Promise<void> {
    const threshold = new Date(
      Date.now() - this.env.WORKSPACE_IDLE_TIMEOUT_MINUTES * 60 * 1000,
    );
    // lastSeenAt 是加 lastSeenAt 迁移时补的 nullable 列，没有 backfill——SQL 里 `NULL < threshold`
    // 恒为 NULL 不是 true，光用 lt 查询会让迁移前就是 RUNNING、之后从未 start/heartbeat 过的
    // workspace 永远扫不到、永远不会被停掉，需要显式 OR lastSeenAt IS NULL 补上。
    const idleWorkspaces = await this.prisma.workspace.findMany({
      where: {
        status: WorkspaceStatus.RUNNING,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: threshold } }],
      },
    });

    for (const workspace of idleWorkspaces) {
      try {
        await this.stopWorkspace(
          workspace,
          { type: AuditActorType.SYSTEM },
          'idle',
        );
      } catch {
        // stopWorkspace 内部已经写了失败审计，这里只是不让一个 workspace 的失败挡住其它的。
      }
    }
  }

  private async stopWorkspace(
    workspace: Workspace,
    actor: AuditActor,
    reason: InternalStopReason,
  ): Promise<Workspace> {
    let vmState: string | undefined;
    try {
      await this.labsClient.stopVm(workspace.labId!);
    } catch (error) {
      // stop 失败不代表 VM 还在跑（可能早已关机或被删），也不代表它已经停了（可能是鉴权/网络故障）。
      // 不从错误码猜，而是再问一次 Labs 的真实状态：只有观察到"已关机"或"确实不存在"才改库，
      // 其余情况保持 RUNNING 并抛错，交给下一轮 sweep 重试——宁可多重试，也不能把还在计费的 VM 标成已停止。
      const observed = await this.observeVmState(workspace.labId!);
      if (observed?.kind === 'missing')
        return this.markVmMissing(workspace, actor, reason);
      if (observed?.state !== 'shut off') {
        const message = error instanceof Error ? error.message : '未知错误';
        const observedState = observed?.state ?? 'unknown';
        // crashed/paused 这类状态下 shutdown 会一直失败，记下观察到的状态，排查时才看得出为什么反复重试。
        this.logger.warn(
          `workspace ${workspace.id} 停止失败，VM ${workspace.labId} 当前状态：${observedState}`,
        );
        await this.audit.record({
          actor,
          action: 'workspace.stop',
          success: false,
          targetType: 'Workspace',
          targetId: workspace.id,
          reason,
          metadata: { vmState: observedState },
        });
        throw new BadGatewayException(message);
      }
      vmState = observed.state;
    }

    const changed = await this.prisma.workspace.updateMany({
      where: { id: workspace.id, status: WorkspaceStatus.RUNNING },
      data: { status: WorkspaceStatus.STOPPED },
    });
    const updated = await this.prisma.workspace.findUnique({
      where: { id: workspace.id },
    });
    if (!updated) throw new NotFoundException('没有找到这个课程的工作区');
    if (changed.count === 0 || updated.status !== WorkspaceStatus.STOPPED)
      return updated;
    await this.audit.record({
      actor,
      action: 'workspace.stop',
      success: true,
      targetType: 'Workspace',
      targetId: workspace.id,
      reason,
      ...(vmState ? { metadata: { vmState } } : {}),
    });
    this.gateway.broadcastStatus(updated);
    return updated;
  }

  // 查询本身失败（鉴权、网络……）时返回 undefined，调用方按"状态未知"处理。
  private async observeVmState(labId: string): Promise<VmState | undefined> {
    try {
      return await this.labsClient.getVmState(labId);
    } catch {
      return undefined;
    }
  }

  // Labs 确认 VM 已不存在：落库 ERROR 而不是 STOPPED——STOPPED 会让用户点 start 继续 404，
  // ERROR 则走 create() 的重建分支。sweep 只查 RUNNING，所以也不会再重试。
  private async markVmMissing(
    workspace: Workspace,
    actor: AuditActor,
    reason: InternalStopReason,
  ): Promise<Workspace> {
    this.logger.warn(
      `workspace ${workspace.id} 的 VM ${workspace.labId} 在 Labs 上已不存在，标记为 ERROR`,
    );
    const changed = await this.prisma.workspace.updateMany({
      where: { id: workspace.id, status: WorkspaceStatus.RUNNING },
      data: {
        status: WorkspaceStatus.ERROR,
        errorMessage: '学习环境已失效，请重新创建。',
      },
    });
    const updated = await this.prisma.workspace.findUnique({
      where: { id: workspace.id },
    });
    if (!updated) throw new NotFoundException('没有找到这个课程的工作区');
    if (changed.count === 0 || updated.status !== WorkspaceStatus.ERROR)
      return updated;
    await this.audit.record({
      actor,
      action: 'workspace.stop',
      success: false,
      targetType: 'Workspace',
      targetId: workspace.id,
      reason,
      metadata: { vmMissing: true },
    });
    this.gateway.broadcastStatus(updated);
    return updated;
  }

  // start 时发现 VM 在 Labs 上已不存在（被删、主机重置……）：直接回到 CREATING 并在后台重建，
  // 学生看到的是"正在准备"而不是 502。重建出来的是全新环境，原 VM 里的数据已无法恢复。
  private async rebuildMissingVm(
    workspace: Workspace,
    userId: string,
    enrollmentGeneration: number,
  ): Promise<Workspace> {
    this.logger.warn(
      `workspace ${workspace.id} 的 VM ${workspace.labId} 在 Labs 上已不存在，重新创建`,
    );
    const changed = await this.prisma.workspace.updateMany({
      where: { id: workspace.id, status: WorkspaceStatus.STOPPED },
      data: {
        status: WorkspaceStatus.CREATING,
        errorMessage: null,
        provisionStartedAt: new Date(),
        provisionGeneration: { increment: 1 },
      },
    });
    const rebuilding = await this.prisma.workspace.findUnique({
      where: { id: workspace.id },
    });
    if (!rebuilding) throw new NotFoundException('没有找到这个课程的工作区');
    if (changed.count === 0 || rebuilding.status !== WorkspaceStatus.CREATING)
      return rebuilding;
    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'workspace.start',
      success: false,
      targetType: 'Workspace',
      targetId: workspace.id,
      metadata: { vmMissing: true },
    });
    this.gateway.broadcastStatus(rebuilding);
    const scheduled = await this.scheduleProvision(
      rebuilding,
      userId,
      enrollmentGeneration,
    );
    if (scheduled) return rebuilding;
    const current = await this.prisma.workspace.findUnique({
      where: { enrollmentId: workspace.enrollmentId },
    });
    if (!current) throw new ConflictException('工作区已重置，请重试');
    return current;
  }

  private isStale(workspace: Workspace): boolean {
    return (
      Date.now() -
        (workspace.provisionStartedAt ?? workspace.createdAt).getTime() >
      STALE_CREATING_MS
    );
  }

  private async requireOwnedEnrollment(userId: string, enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment || enrollment.userId !== userId) {
      throw new ForbiddenException('无权访问这个 enrollment');
    }
    return enrollment;
  }
}
