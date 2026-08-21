import { Test } from '@nestjs/testing';
import { AdminService } from '../admin.service';
import { InviteCommand } from './invite.command';

const OPERATOR = 'ops@example.com';
const REASON = '封测名单批次 1';

const buildCommand = async (admin: Partial<AdminService> = {}) => {
  const moduleRef = await Test.createTestingModule({
    providers: [InviteCommand, { provide: AdminService, useValue: admin }],
  }).compile();
  return moduleRef.get(InviteCommand);
};

describe('InviteCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService，只打印将要发生的变更', async () => {
    const inviteUser = jest.fn();
    const command = await buildCommand({ inviteUser });

    await command.run(['new@example.com'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(inviteUser).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'invite',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        email: 'new@example.com',
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService 并打印真实结果', async () => {
    const expiresAt = new Date('2026-08-19T00:00:00.000Z');
    const inviteUser = jest.fn().mockResolvedValue({
      userId: 'user_1',
      email: 'new@example.com',
      invitationToken: 'plain-token',
      expiresAt,
    });
    const command = await buildCommand({ inviteUser });

    await command.run(['new@example.com'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(inviteUser).toHaveBeenCalledWith(
      'new@example.com',
      OPERATOR,
      REASON,
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'invite',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        email: 'new@example.com',
        invitationToken: 'plain-token',
        expiresAt: expiresAt.toISOString(),
      }),
    );
  });

  it('operator 不是合法邮箱时拒绝，且不调用 AdminService', async () => {
    const inviteUser = jest.fn();
    const command = await buildCommand({ inviteUser });

    await expect(
      command.run(['new@example.com'], {
        operator: 'not-an-email',
        reason: REASON,
      }),
    ).rejects.toThrow('operator 必须是合法邮箱');
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('reason 为空字符串时拒绝', async () => {
    const inviteUser = jest.fn();
    const command = await buildCommand({ inviteUser });

    await expect(
      command.run(['new@example.com'], { operator: OPERATOR, reason: '' }),
    ).rejects.toThrow('reason 不能为空');
    expect(inviteUser).not.toHaveBeenCalled();
  });
});
