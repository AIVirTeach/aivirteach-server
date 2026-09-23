import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';
import { verifyAccessToken } from './tokens';

export type AuthenticatedRequest = Request & {
  auth?: { userId: string; email: string };
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    // 正常请求都走 Authorization 头；只有 header 缺失时才回退到 query string ——
    // 给 navigator.sendBeacon() 用（浏览器关标签页时发的请求不能带自定义头），
    // 跟 WorkspaceGateway 的 WS 鉴权是同一个理由，见那边的注释。
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (request.query?.token as string | undefined);
    if (!token) {
      throw new UnauthorizedException('缺少 Bearer token');
    }

    try {
      const claims = await verifyAccessToken(token, this.env.JWT_SECRET);
      request.auth = { userId: claims.sub, email: claims.email };
      return true;
    } catch {
      throw new UnauthorizedException('token 无效或已过期');
    }
  }
}
