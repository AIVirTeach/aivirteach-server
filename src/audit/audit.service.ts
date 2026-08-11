import { Injectable } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditActor =
  | { type: typeof AuditActorType.USER; id: string | null }
  | { type: typeof AuditActorType.OPERATOR; id: string }
  | { type: typeof AuditActorType.SYSTEM };

export interface RecordAuditEventInput {
  actor: AuditActor;
  action: string;
  success: boolean;
  targetType?: string;
  targetId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// 全项目唯一允许写 AuditEvent 的地方；只增不改不删，别的地方不要直接碰 prisma.auditEvent。
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorType: input.actor.type,
        actorId: input.actor.type === AuditActorType.SYSTEM ? null : input.actor.id,
        action: input.action,
        success: input.success,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata,
      },
    });
  }
}
