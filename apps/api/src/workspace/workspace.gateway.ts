import { Inject, Injectable } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { ENV, type Env } from '../config/env';
import { verifyAccessToken, type AccessTokenClaims } from '../auth/tokens';
import { PrismaService } from '../prisma/prisma.service';

type WorkspaceSocket = WebSocket & { enrollmentId?: string };

type BroadcastableWorkspace = { id: string; enrollmentId: string; status: string; [key: string]: unknown };

// 浏览器原生 WebSocket 不能带自定义请求头，鉴权 token 只能放 query string——
// 跟 access token 15 分钟 TTL 配套，泄露到日志里的窗口很短，可以接受。
@WebSocketGateway({ path: '/api/v1/workspaces/socket' })
@Injectable()
export class WorkspaceGateway implements OnGatewayConnection {
  private readonly sockets = new Set<WorkspaceSocket>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: WorkspaceSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? '', 'http://internal');
    const token = url.searchParams.get('token');
    const enrollmentId = url.searchParams.get('enrollmentId');

    if (!token || !enrollmentId) {
      client.close(4001, '缺少 token 或 enrollmentId');
      return;
    }

    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(token, this.env.JWT_SECRET);
    } catch {
      client.close(4001, 'token 无效或已过期');
      return;
    }

    const enrollment = await this.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment || enrollment.userId !== claims.sub) {
      client.close(4001, '无权访问这个 enrollment');
      return;
    }

    client.enrollmentId = enrollmentId;
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
  }

  broadcastStatus(workspace: BroadcastableWorkspace): void {
    const payload = JSON.stringify({ type: 'workspace.status', workspace });
    for (const socket of this.sockets) {
      if (socket.enrollmentId === workspace.enrollmentId && socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
