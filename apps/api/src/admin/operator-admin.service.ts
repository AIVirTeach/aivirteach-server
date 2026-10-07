import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { EmailSchema } from '../operator-auth/operator-auth.schemas';

export interface OperatorChangeContext {
  operator: string;
  reason: string;
  execute: boolean;
}

export interface OperatorChangeResult {
  dryRun: boolean;
  email: string;
  // 只有 add / reset 真正执行时才有，且只在这一次返回里出现。
  password?: string;
}

const generatePassword = (): string => randomBytes(18).toString('base64url');

// 运营账号只有少数几个人，由 CLI 直接写库（没有邀请、没有「忘记密码」流程）。
// dry-run 也先校验邮箱，避免「预演通过、真正执行才失败」。
@Injectable()
export class OperatorAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async add(
    rawEmail: string,
    ctx: OperatorChangeContext,
  ): Promise<OperatorChangeResult> {
    const email = EmailSchema.parse(rawEmail);
    const existing = await this.prisma.operator.findUnique({
      where: { email },
    });
    if (existing) {
      throw new ConflictException(`运营已存在：${email}`);
    }
    if (!ctx.execute) {
      return { dryRun: true, email };
    }

    const password = generatePassword();
    const [created] = await this.prisma.$transaction([
      this.prisma.operator.create({
        data: { email, passwordHash: await hashPassword(password) },
      }),
      this.stampPasswordChanged(email),
    ]);
    await this.recordChange('admin.operator.add', created.id, ctx);
    return { dryRun: false, email, password };
  }

  async reset(
    rawEmail: string,
    ctx: OperatorChangeContext,
  ): Promise<OperatorChangeResult> {
    const email = EmailSchema.parse(rawEmail);
    const operator = await this.requireOperator(email);
    if (!ctx.execute) {
      return { dryRun: true, email };
    }

    const password = generatePassword();
    // passwordChangedAt 由数据库写入（见 stampPasswordChanged），不用跑 CLI 的这台机器的时钟。
    await this.prisma.$transaction([
      this.prisma.operator.update({
        where: { id: operator.id },
        data: {
          passwordHash: await hashPassword(password),
          // 解除登录锁定；早于 passwordChangedAt 签发的登录令牌随之失效。
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      this.stampPasswordChanged(email),
    ]);
    await this.recordChange('admin.operator.reset', operator.id, ctx);
    return { dryRun: false, email, password };
  }

  async disable(
    rawEmail: string,
    ctx: OperatorChangeContext,
  ): Promise<OperatorChangeResult> {
    const email = EmailSchema.parse(rawEmail);
    const operator = await this.requireOperator(email);
    if (!ctx.execute) {
      return { dryRun: true, email };
    }

    await this.prisma.operator.update({
      where: { id: operator.id },
      data: { status: 'DISABLED' },
    });
    await this.recordChange('admin.operator.disable', operator.id, ctx);
    return { dryRun: false, email };
  }

  // 令牌的签发时间来自 API 服务器的时钟，所以 passwordChangedAt 也必须取数据库的时间：
  // 用本机时钟的话，机器时间偏快会让新令牌一出生就被判作废，偏慢则让重置前的令牌继续有效。
  private stampPasswordChanged(email: string) {
    return this.prisma
      .$executeRaw`UPDATE "Operator" SET "passwordChangedAt" = (now() AT TIME ZONE 'UTC') WHERE "email" = ${email}`;
  }

  private async requireOperator(email: string) {
    const operator = await this.prisma.operator.findUnique({
      where: { email },
    });
    if (!operator) {
      throw new NotFoundException(`找不到运营：${email}`);
    }
    return operator;
  }

  private recordChange(
    action: string,
    operatorId: string,
    ctx: OperatorChangeContext,
  ): Promise<void> {
    return this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: ctx.operator },
      action,
      success: true,
      targetType: 'Operator',
      targetId: operatorId,
      reason: ctx.reason,
    });
  }
}
