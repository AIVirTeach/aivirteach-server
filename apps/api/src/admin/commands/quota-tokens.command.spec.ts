import { Test } from '@nestjs/testing';
import { AdminService } from '../admin.service';
import { QuotaGrantTokensCommand } from './quota-tokens.command';

const OPERATOR = 'ops@example.com';
const REASON = '封测首批 token 额度';

const buildCommand = async (admin: Partial<AdminService> = {}) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      QuotaGrantTokensCommand,
      { provide: AdminService, useValue: admin },
    ],
  }).compile();
  return moduleRef.get(QuotaGrantTokensCommand);
};

describe('QuotaGrantTokensCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService，且把 token 数解析成数字', async () => {
    const grantTokenQuota = jest.fn();
    const command = await buildCommand({ grantTokenQuota });

    await command.run(['a@b.com', '1000000'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(grantTokenQuota).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'quota:grant-tokens',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        tokens: 1000000,
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService', async () => {
    const grantTokenQuota = jest
      .fn()
      .mockResolvedValue({ tokensDelta: 1000000 });
    const command = await buildCommand({ grantTokenQuota });

    await command.run(['a@b.com', '1000000'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(grantTokenQuota).toHaveBeenCalledWith(
      'a@b.com',
      1000000,
      OPERATOR,
      REASON,
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'quota:grant-tokens',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        tokensDelta: 1000000,
      }),
    );
  });

  it.each(['-5', '0', '1.5', 'abc'])(
    'token 数 %s 不是正整数时拒绝，且不调用 AdminService',
    async (tokens) => {
      const grantTokenQuota = jest.fn();
      const command = await buildCommand({ grantTokenQuota });

      await expect(
        command.run(['a@b.com', tokens], {
          operator: OPERATOR,
          reason: REASON,
          execute: true,
        }),
      ).rejects.toThrow('token 数必须是正整数');
      expect(grantTokenQuota).not.toHaveBeenCalled();
    },
  );

  it('operator 不是合法邮箱时拒绝', async () => {
    const grantTokenQuota = jest.fn();
    const command = await buildCommand({ grantTokenQuota });

    await expect(
      command.run(['a@b.com', '1000'], { operator: 'nope', reason: REASON }),
    ).rejects.toThrow('operator 必须是合法邮箱');
    expect(grantTokenQuota).not.toHaveBeenCalled();
  });
});
