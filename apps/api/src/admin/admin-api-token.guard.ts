import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';

@Injectable()
export class AdminApiTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';

    const providedDigest = createHash('sha256').update(token).digest();
    const expectedDigest = createHash('sha256')
      .update(this.env.ADMIN_API_TOKEN)
      .digest();
    if (!token || !timingSafeEqual(providedDigest, expectedDigest)) {
      throw new UnauthorizedException('缺少或无效的 admin 令牌');
    }

    return true;
  }
}
