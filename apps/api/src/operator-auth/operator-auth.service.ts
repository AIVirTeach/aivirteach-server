import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { hashPassword, verifyPassword } from '../auth/password';
import {
  TOKEN_AUDIENCE_ADMIN,
  signAccessToken,
  ttlToSeconds,
} from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export const DENIED = '凭证无效';
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;

export interface OperatorSession {
  accessToken: string;
  expiresIn: number;
}

// 邮箱不存在时拿它做一次哈希比较，让「没有这个邮箱」和「密码错」耗时相近。
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> =>
  (dummyHash ??= hashPassword('operator-auth-dummy-password'));

@Injectable()
export class OperatorAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string): Promise<OperatorSession> {
    const operator = await this.prisma.operator.findUnique({
      where: { email },
    });
    const passwordMatches = await verifyPassword(
      operator?.passwordHash ?? (await getDummyHash()),
      password,
    );
    const now = new Date();
    const locked = !!operator?.lockedUntil && operator.lockedUntil > now;

    // 不存在、已停用、锁定期内：统一拒绝，不计数（不存在的邮箱没有计数行可记）。
    if (!operator || operator.status !== 'ACTIVE' || locked) {
      await this.recordLogin(email, false);
      throw new UnauthorizedException(DENIED);
    }

    if (!passwordMatches) {
      await this.registerFailure(operator, now);
      await this.recordLogin(email, false);
      throw new UnauthorizedException(DENIED);
    }

    // 校验密码期间可能已被并发的失败请求锁定：清零必须带「未锁定」条件，否则会把刚设上的锁抹掉。
    const released = await this.prisma.operator.updateMany({
      where: {
        id: operator.id,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    if (released.count === 0) {
      await this.recordLogin(email, false);
      throw new UnauthorizedException(DENIED);
    }
    await this.recordLogin(email, true);

    const accessToken = await signAccessToken(
      { sub: operator.id, email: operator.email },
      this.env.JWT_SECRET,
      this.env.OPERATOR_SESSION_TTL,
      TOKEN_AUDIENCE_ADMIN,
    );
    return {
      accessToken,
      expiresIn: ttlToSeconds(this.env.OPERATOR_SESSION_TTL),
    };
  }

  private async registerFailure(
    operator: { id: string; email: string },
    now: Date,
  ): Promise<void> {
    // 上一轮锁定已过期：重新从 1 开始数，否则输错一次就会被立刻再锁 15 分钟。
    // 带条件的 updateMany 只会被并发请求里的第一个命中，其余的落到下面的自增。
    const restarted = await this.prisma.operator.updateMany({
      where: { id: operator.id, lockedUntil: { lte: now } },
      data: { failedLoginCount: 1, lockedUntil: null },
    });
    if (restarted.count === 1) {
      return;
    }

    // 原子自增：并发的错误尝试不会互相覆盖计数。
    const { failedLoginCount } = await this.prisma.operator.update({
      where: { id: operator.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount < MAX_FAILED_LOGINS) {
      return;
    }

    // 只有真正把锁设上的那一个请求写审计；已被别的请求锁住时不再延长。
    const locked = await this.prisma.operator.updateMany({
      where: {
        id: operator.id,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
    if (locked.count === 0) {
      return;
    }
    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator.email },
      action: 'admin.auth.locked',
      success: true,
      targetType: 'Operator',
      targetId: operator.id,
    });
  }

  private recordLogin(email: string, success: boolean): Promise<void> {
    return this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: email },
      action: 'admin.auth.login',
      success,
    });
  }
}
