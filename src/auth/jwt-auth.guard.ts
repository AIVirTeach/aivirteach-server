import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';
import { ALLOW_QUERY_TOKEN_KEY } from './allow-query-token.decorator';
import { verifyAccessToken } from './tokens';

export type AuthenticatedRequest = Request & {
  auth?: { userId: string; email: string };
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    // 正常请求都走 Authorization 头；只有 header 缺失、且这个 handler 显式标了
    // @AllowQueryToken() 时才回退到 query string——给 navigator.sendBeacon() 这类
    // 发不了自定义 header 的请求用。默认不允许，避免短生命周期 token 无谓地泄进
    // 每个认证路由的访问日志/浏览器历史。
    const allowQueryToken = this.reflector.getAllAndOverride<boolean>(ALLOW_QUERY_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : allowQueryToken
        ? (request.query?.token as string | undefined)
        : undefined;
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
