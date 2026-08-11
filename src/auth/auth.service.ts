import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
  ttlToSeconds,
} from './tokens';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// 所有鉴权失败对外都是同一句话，防止用报错差异枚举账号。
const DENIED = '凭证无效';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  async acceptInvitation(token: string, password: string): Promise<TokenPair> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { user: true },
    });

    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.expiresAt <= new Date()
    ) {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: invitation?.userId ?? null },
        action: 'auth.acceptInvitation',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    const passwordHash = await hashPassword(password);
    await this.prisma.user.update({
      where: { id: invitation.userId },
      data: { passwordHash, status: 'ACTIVE' },
    });
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: invitation.user.id },
      action: 'auth.acceptInvitation',
      success: true,
    });

    return this.issueTokens(invitation.user.id, invitation.user.email);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user?.passwordHash || user.status !== 'ACTIVE') {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: user?.id ?? null },
        action: 'auth.login',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: user.id },
        action: 'auth.login',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: user.id },
      action: 'auth.login',
      success: true,
    });

    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
      include: { user: true },
    });

    if (!stored) {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: null },
        action: 'auth.refresh',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    // 已经轮换过的 token 又被拿来用 —— 说明泄露了，把这个用户所有未撤销的 token 一并作废。
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: stored.userId },
        action: 'auth.refresh',
        success: false,
        reason: '检测到已撤销 token 被重放，已撤销整个 token 家族',
      });
      throw new UnauthorizedException(DENIED);
    }

    if (stored.expiresAt <= new Date() || stored.user.status !== 'ACTIVE') {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: stored.userId },
        action: 'auth.refresh',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    const { pair, refreshTokenId } = await this.issueTokensWithId(
      stored.user.id,
      stored.user.email,
    );

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: refreshTokenId },
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: stored.userId },
      action: 'auth.refresh',
      success: true,
    });

    return pair;
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
      include: { user: true },
    });

    // 登出必须幂等：token 不存在或已撤销都当作成功，且不写审计——重复点登出不是安全事件。
    if (!stored || stored.revokedAt) {
      return;
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: stored.userId },
      action: 'auth.logout',
      success: true,
    });
  }

  private async issueTokens(userId: string, email: string): Promise<TokenPair> {
    const { pair } = await this.issueTokensWithId(userId, email);
    return pair;
  }

  // refresh 需要知道新建 token 的 id 才能写轮换链，所以 create 的返回值必须传回去，
  // 不要事后再按 tokenHash 查一次。
  private async issueTokensWithId(
    userId: string,
    email: string,
  ): Promise<{ pair: TokenPair; refreshTokenId: string }> {
    const accessToken = await signAccessToken(
      { sub: userId, email },
      this.env.JWT_SECRET,
      this.env.ACCESS_TOKEN_TTL,
    );

    const refreshToken = generateOpaqueToken();
    const created = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(
          Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
        ),
      },
    });

    return {
      pair: {
        accessToken,
        refreshToken,
        // 客户端要靠这个字段判断何时该刷新，必须是 access token（真正会过期的那个）的寿命
        expiresIn: ttlToSeconds(this.env.ACCESS_TOKEN_TTL),
      },
      refreshTokenId: created.id,
    };
  }
}
