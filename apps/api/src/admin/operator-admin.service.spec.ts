import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { verifyPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAdminService } from './operator-admin.service';

const CTX = { operator: 'owner@example.com', reason: '新增运营' };

const build = async () => {
  const prisma = {
    operator: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    // 与真实的数组式事务等价：语句已在构造数组时发出，这里只负责等它们完成。
    $transaction: jest.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const audit = { record: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      OperatorAdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(OperatorAdminService), prisma, audit };
};

describe('OperatorAdminService.add', () => {
  it('dry-run：不写库、不生成密码', async () => {
    const { service, prisma } = await build();
    prisma.operator.findUnique.mockResolvedValue(null);

    const result = await service.add(' New@X.com ', { ...CTX, execute: false });

    expect(result).toEqual({ dryRun: true, email: 'new@x.com' });
    expect(prisma.operator.create).not.toHaveBeenCalled();
  });

  it('--execute：库里只存哈希，返回一次性明文密码，并记审计', async () => {
    const { service, prisma, audit } = await build();
    prisma.operator.findUnique.mockResolvedValue(null);
    prisma.operator.create.mockImplementation(
      ({ data }: { data: { email: string; passwordHash: string } }) =>
        Promise.resolve({ id: 'op_9', ...data }),
    );

    const result = await service.add('new@x.com', { ...CTX, execute: true });

    expect(result.dryRun).toBe(false);
    expect(result.password).toBeDefined();
    expect(result.password!.length).toBeGreaterThanOrEqual(16);
    const stored = prisma.operator.create.mock.calls[0][0] as {
      data: { email: string; passwordHash: string };
    };
    expect(stored.data.email).toBe('new@x.com');
    expect(stored.data.passwordHash).not.toContain(result.password);
    await expect(
      verifyPassword(stored.data.passwordHash, result.password!),
    ).resolves.toBe(true);
    // passwordChangedAt 交给数据库写，不用跑 CLI 的这台机器的时钟。
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0][0].join('?')).toContain(
      '"passwordChangedAt" = (now()',
    );
    expect(prisma.$executeRaw.mock.calls[0][1]).toBe('new@x.com');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'OPERATOR', id: 'owner@example.com' },
        action: 'admin.operator.add',
        targetType: 'Operator',
        targetId: 'op_9',
        reason: '新增运营',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      result.password,
    );
  });

  it('邮箱已存在：报错、不覆盖密码（dry-run 也报）', async () => {
    const { service, prisma } = await build();
    prisma.operator.findUnique.mockResolvedValue({ id: 'op_1' });

    await expect(
      service.add('new@x.com', { ...CTX, execute: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.add('new@x.com', { ...CTX, execute: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.operator.create).not.toHaveBeenCalled();
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('不是邮箱 → 抛错', async () => {
    const { service } = await build();

    await expect(
      service.add('nope', { ...CTX, execute: true }),
    ).rejects.toThrow();
  });
});

describe('OperatorAdminService.reset', () => {
  it('邮箱不存在：dry-run 就报「找不到运营」', async () => {
    const { service, prisma } = await build();
    prisma.operator.findUnique.mockResolvedValue(null);

    await expect(
      service.reset('ghost@x.com', { ...CTX, execute: false }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.reset('ghost@x.com', { ...CTX, execute: false }),
    ).rejects.toThrow('找不到运营：ghost@x.com');
  });

  it('dry-run：不写库', async () => {
    const { service, prisma } = await build();
    prisma.operator.findUnique.mockResolvedValue({ id: 'op_1' });

    const result = await service.reset('op@x.com', { ...CTX, execute: false });

    expect(result).toEqual({ dryRun: true, email: 'op@x.com' });
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('--execute：换新密码、由数据库写 passwordChangedAt、清零失败计数和锁定', async () => {
    const { service, prisma, audit } = await build();
    prisma.operator.findUnique.mockResolvedValue({ id: 'op_1' });
    prisma.operator.update.mockResolvedValue({});

    const result = await service.reset('Op@X.com', { ...CTX, execute: true });

    const call = prisma.operator.update.mock.calls[0][0] as {
      where: { id: string };
      data: {
        passwordHash: string;
        failedLoginCount: number;
        lockedUntil: null;
      };
    };
    expect(call.where).toEqual({ id: 'op_1' });
    expect(call.data.failedLoginCount).toBe(0);
    expect(call.data.lockedUntil).toBeNull();
    expect(call.data).not.toHaveProperty('passwordChangedAt');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0][0].join('?')).toContain(
      '"passwordChangedAt" = (now()',
    );
    expect(prisma.$executeRaw.mock.calls[0][1]).toBe('op@x.com');
    await expect(
      verifyPassword(call.data.passwordHash, result.password!),
    ).resolves.toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.operator.reset' }),
    );
  });
});

describe('OperatorAdminService.disable', () => {
  it('邮箱不存在：dry-run 就报「找不到运营」', async () => {
    const { service, prisma } = await build();
    prisma.operator.findUnique.mockResolvedValue(null);

    await expect(
      service.disable('ghost@x.com', { ...CTX, execute: false }),
    ).rejects.toThrow('找不到运营：ghost@x.com');
  });

  it('--execute：状态置 DISABLED 并记审计', async () => {
    const { service, prisma, audit } = await build();
    prisma.operator.findUnique.mockResolvedValue({ id: 'op_1' });
    prisma.operator.update.mockResolvedValue({});

    const result = await service.disable('op@x.com', {
      ...CTX,
      execute: true,
    });

    expect(result).toEqual({ dryRun: false, email: 'op@x.com' });
    expect(prisma.operator.update).toHaveBeenCalledWith({
      where: { id: 'op_1' },
      data: { status: 'DISABLED' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.operator.disable' }),
    );
  });

  it('dry-run：不写库', async () => {
    const { service, prisma } = await build();
    prisma.operator.findUnique.mockResolvedValue({ id: 'op_1' });

    await service.disable('op@x.com', { ...CTX, execute: false });

    expect(prisma.operator.update).not.toHaveBeenCalled();
  });
});
