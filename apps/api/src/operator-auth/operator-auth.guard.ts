import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyAdminAccessToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export type OperatorRequest = Request & {
  operator?: { id: string; email: string };
};

const DENIED = '凭证无效';

@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      throw new UnauthorizedException(DENIED);
    }

    const claims = await verifyAdminAccessToken(
      token,
      this.env.JWT_SECRET,
    ).catch(() => {
      throw new UnauthorizedException(DENIED);
    });

    // 每次请求都查库：停用、重置密码立刻生效，不用等令牌自然过期。
    const operator = await this.prisma.operator.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, status: true, passwordChangedAt: true },
    });
    const issuedBeforePasswordChange =
      !!operator &&
      claims.iat < Math.floor(operator.passwordChangedAt.getTime() / 1000);
    if (
      !operator ||
      operator.status !== 'ACTIVE' ||
      issuedBeforePasswordChange
    ) {
      throw new UnauthorizedException(DENIED);
    }

    request.operator = { id: operator.id, email: operator.email };
    return true;
  }
}
