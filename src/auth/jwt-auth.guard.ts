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

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Bearer token');
    }

    try {
      const claims = await verifyAccessToken(
        header.slice(7),
        this.env.JWT_SECRET,
      );
      request.auth = { userId: claims.sub, email: claims.email };
      return true;
    } catch {
      throw new UnauthorizedException('token 无效或已过期');
    }
  }
}
