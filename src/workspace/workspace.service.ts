import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditActorType, WorkspaceStatus, type Workspace } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { generateOpaqueToken } from '../auth/tokens';
import { LabsClient } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';

const STALE_CREATING_MS = 5 * 60 * 1000;
const CONSOLE_TOKEN_TTL_SECONDS = 300;

export type ConsoleSessionResult = {
  wsUrl: string;
  rdpUsername: string;
  rdpPassword: string;
  expiresAt: string;
};

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
    if (!this.env.LABS_CONSOLE_WS_URL) {
      throw new ServiceUnavailableException('远程桌面服务未配置：缺少 LABS_CONSOLE_WS_URL');
    }

    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.RUNNING) {
      throw new ConflictException('工作区还没准备好，请稍后再试');
    }

    // status === RUNNING 时 labId/rdpUsername 一定有值——两者在 provisionInBackground 里
    // 跟 status 更新是同一次 prisma.workspace.update() 调用，不会出现「RUNNING 但缺字段」的状态。
    const token = generateOpaqueToken();
    const ttlSeconds = CONSOLE_TOKEN_TTL_SECONDS;
    let credentialsPassword: string;
    try {
      await this.labsClient.registerConsoleToken(workspace.labId!, token, ttlSeconds);
      credentialsPassword = (await this.labsClient.getCredentials(workspace.labId!)).password;
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

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'workspace.console-session',
      success: true,
      targetType: 'Workspace',
      targetId: workspace.id,
    });

    return {
      wsUrl: `${this.env.LABS_CONSOLE_WS_URL}/?token=${token}`,
      rdpUsername: workspace.rdpUsername!,
      rdpPassword: credentialsPassword,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
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
