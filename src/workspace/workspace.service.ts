import { BadGatewayException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType, WorkspaceStatus, type Workspace } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditActor } from '../audit/audit.service';
import { LabsClient, type BrowserSession, type GuacamoleToken } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';

const STALE_CREATING_MS = 5 * 60 * 1000;

export type ConsoleSessionResult = BrowserSession;
export type StopReason = 'manual' | 'beacon';
type InternalStopReason = StopReason | 'idle';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly labsClient: LabsClient,
    private readonly gateway: WorkspaceGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async getForEnrollment(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');

    if (workspace.status === WorkspaceStatus.CREATING && this.isStale(workspace)) {
      return this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' },
      });
    }
    return workspace;
  }

  async createConsoleSession(userId: string, enrollmentId: string): Promise<ConsoleSessionResult> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.RUNNING) {
      throw new ConflictException('工作区还没准备好，请稍后再试');
    }

    let session: BrowserSession;
    try {
      session = await this.labsClient.createBrowserSession(workspace.labId!, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.console-session',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      throw new BadGatewayException(`无法连接远程桌面服务：${message}`);
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
  async exchangeConsoleToken(userId: string, enrollmentId: string, data: string): Promise<GuacamoleToken> {
    await this.requireOwnedEnrollment(userId, enrollmentId);
    try {
      return await this.labsClient.exchangeGuacamoleToken(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      throw new BadGatewayException(`无法建立远程桌面会话：${message}`);
    }
  }

  async create(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const existing = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });

    // 已经在建或已经好了：直接把现状交回去，不重复发起创建（DB 唯一约束也会挡，这里提前短路更省事）。
    if (existing && existing.status !== WorkspaceStatus.ERROR) return existing;

    const workspace = await this.prisma.workspace.upsert({
      where: { enrollmentId: enrollment.id },
      update: { status: WorkspaceStatus.CREATING, errorMessage: null },
      create: { enrollmentId: enrollment.id, status: WorkspaceStatus.CREATING },
    });

    // Labs 的 POST /v1/vms 最长阻塞 180 秒；用 waitUntil 在这次请求返回 202 之后继续跑，
    // 不让 client 裸等。函数实例中途被回收会丢掉这次后台任务——这是选这个简单方案接受的代价，
    // 靠 getForEnrollment 里的 5 分钟过期判断兜底，见本文档 Global Constraints。
    waitUntil(this.provisionInBackground(workspace.id, userId));
    return workspace;
  }

  // 不是 private：测试直接调用它，绕开 waitUntil 的运行时行为。
  async provisionInBackground(workspaceId: string, userId: string): Promise<void> {
    try {
      const result = await this.labsClient.createVm(workspaceId);
      const updated = await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          status: WorkspaceStatus.RUNNING,
          labId: result.labId,
          rdpUsername: result.username,
          rdpPort: result.rdpPort,
          errorMessage: null,
          lastSeenAt: new Date(),
        },
      });
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.create',
        success: true,
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      this.gateway.broadcastStatus(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      const updated = await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: WorkspaceStatus.ERROR, errorMessage: message },
      });
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.create',
        success: false,
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      this.gateway.broadcastStatus(updated);
    }
  }

  async stop(userId: string, enrollmentId: string, reason: StopReason): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    // 已经不是 RUNNING：可能是重复触发（beacon 打两次、关闭前先被空闲扫描停了），幂等返回现状。
    if (workspace.status !== WorkspaceStatus.RUNNING) return workspace;

    return this.stopWorkspace(workspace, { type: AuditActorType.USER, id: userId }, reason);
  }

  async start(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.STOPPED) return workspace;

    try {
      await this.labsClient.startVm(workspace.labId!);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.start',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      throw new BadGatewayException(`无法启动远程桌面：${message}`);
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: WorkspaceStatus.RUNNING, lastSeenAt: new Date() },
    });
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
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
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
    const threshold = new Date(Date.now() - this.env.WORKSPACE_IDLE_TIMEOUT_MINUTES * 60 * 1000);
    // lastSeenAt 是加 lastSeenAt 迁移时补的 nullable 列，没有 backfill——SQL 里 `NULL < threshold`
    // 恒为 NULL 不是 true，光用 lt 查询会让迁移前就是 RUNNING、之后从未 start/heartbeat 过的
    // workspace 永远扫不到、永远不会被停掉，需要显式 OR lastSeenAt IS NULL 补上。
    const idleWorkspaces = await this.prisma.workspace.findMany({
      where: { status: WorkspaceStatus.RUNNING, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: threshold } }] },
    });

    for (const workspace of idleWorkspaces) {
      try {
        await this.stopWorkspace(workspace, { type: AuditActorType.SYSTEM }, 'idle');
      } catch {
        // stopWorkspace 内部已经写了失败审计，这里只是不让一个 workspace 的失败挡住其它的。
      }
    }
  }

  private async stopWorkspace(workspace: Workspace, actor: AuditActor, reason: InternalStopReason): Promise<Workspace> {
    try {
      await this.labsClient.stopVm(workspace.labId!);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      await this.audit.record({
        actor,
        action: 'workspace.stop',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
        reason,
      });
      throw new BadGatewayException(`无法停止远程桌面：${message}`);
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: WorkspaceStatus.STOPPED },
    });
    await this.audit.record({
      actor,
      action: 'workspace.stop',
      success: true,
      targetType: 'Workspace',
      targetId: workspace.id,
      reason,
    });
    this.gateway.broadcastStatus(updated);
    return updated;
  }

  private isStale(workspace: Workspace): boolean {
    return Date.now() - workspace.createdAt.getTime() > STALE_CREATING_MS;
  }

  private async requireOwnedEnrollment(userId: string, enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment || enrollment.userId !== userId) {
      throw new ForbiddenException('无权访问这个 enrollment');
    }
    return enrollment;
  }
}
