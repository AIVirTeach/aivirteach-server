import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

const buildService = async (create: jest.Mock) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuditService,
      { provide: PrismaService, useValue: { auditEvent: { create } } },
    ],
  }).compile();
  return moduleRef.get(AuditService);
};

describe('AuditService.record', () => {
  it('USER 事件把 actor.id 写进 actorId', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = await buildService(create);

    await service.record({
      actor: { type: AuditActorType.USER, id: 'user_1' },
      action: 'auth.login',
      success: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: AuditActorType.USER,
        actorId: 'user_1',
        action: 'auth.login',
        success: true,
        reason: null,
      }),
    });
  });

  it('SYSTEM 事件的 actorId 强制为 null，即使传了 id 之外的字段', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = await buildService(create);

    await service.record({
      actor: { type: AuditActorType.SYSTEM },
      action: 'quota.expire',
      success: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: AuditActorType.SYSTEM,
        actorId: null,
      }),
    });
  });

  it('OPERATOR 事件带 reason 和 target 时原样落库', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = await buildService(create);

    await service.record({
      actor: { type: AuditActorType.OPERATOR, id: 'ops@example.com' },
      action: 'admin.inviteUser',
      success: true,
      targetType: 'User',
      targetId: 'user_2',
      reason: '封测名单批次 3',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: AuditActorType.OPERATOR,
        actorId: 'ops@example.com',
        targetType: 'User',
        targetId: 'user_2',
        reason: '封测名单批次 3',
      }),
    });
  });
});
