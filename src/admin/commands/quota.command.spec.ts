import { Test } from '@nestjs/testing';
import { AdminService } from '../admin.service';
import { QuotaGrantCommand } from './quota.command';

const OPERATOR = 'ops@example.com';
const REASON = '开学配额';

const buildCommand = async (admin: Partial<AdminService> = {}) => {
  const moduleRef = await Test.createTestingModule({
    providers: [QuotaGrantCommand, { provide: AdminService, useValue: admin }],
  }).compile();
  return moduleRef.get(QuotaGrantCommand);
};

describe('QuotaGrantCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService，且把分钟数解析成数字', async () => {
    const grantQuota = jest.fn();
    const command = await buildCommand({ grantQuota });

    await command.run(['a@b.com', '120'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(grantQuota).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'quota:grant',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        minutes: 120,
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService', async () => {
    const grantQuota = jest.fn().mockResolvedValue({ minutesDelta: 120 });
    const command = await buildCommand({ grantQuota });

    await command.run(['a@b.com', '120'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(grantQuota).toHaveBeenCalledWith('a@b.com', 120, OPERATOR, REASON);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'quota:grant',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        minutesDelta: 120,
      }),
    );
  });

  it('分钟数不是正整数时拒绝，且不调用 AdminService', async () => {
    const grantQuota = jest.fn();
    const command = await buildCommand({ grantQuota });

    await expect(
      command.run(['a@b.com', '-5'], { operator: OPERATOR, reason: REASON }),
    ).rejects.toThrow('分钟数必须是正整数');
    expect(grantQuota).not.toHaveBeenCalled();
  });

  it('operator 不是合法邮箱时拒绝', async () => {
    const grantQuota = jest.fn();
    const command = await buildCommand({ grantQuota });

    await expect(
      command.run(['a@b.com', '120'], { operator: 'nope', reason: REASON }),
    ).rejects.toThrow('operator 必须是合法邮箱');
    expect(grantQuota).not.toHaveBeenCalled();
  });
});
