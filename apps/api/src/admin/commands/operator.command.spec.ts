import { Test } from '@nestjs/testing';
import { OperatorAdminService } from '../operator-admin.service';
import {
  OperatorAddCommand,
  OperatorDisableCommand,
  OperatorResetCommand,
} from './operator.command';

const OPERATOR = 'owner@example.com';
const REASON = '新增运营';

const build = async <T>(
  command: new (service: OperatorAdminService) => T,
  service: Partial<OperatorAdminService>,
): Promise<T> => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      command as never,
      { provide: OperatorAdminService, useValue: service },
    ],
  }).compile();
  return moduleRef.get(command as never);
};

describe('operator CLI commands', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });
  afterEach(() => logSpy.mockRestore());

  it('operator:add 默认 dry-run，输出里没有密码', async () => {
    const add = jest.fn().mockResolvedValue({ dryRun: true, email: 'a@b.com' });
    const command = await build(OperatorAddCommand, { add });

    await command.run(['a@b.com'], { operator: OPERATOR, reason: REASON });

    expect(add).toHaveBeenCalledWith('a@b.com', {
      operator: OPERATOR,
      reason: REASON,
      execute: false,
    });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'operator:add',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('operator:add --execute 把一次性密码打印出来', async () => {
    const add = jest
      .fn()
      .mockResolvedValue({
        dryRun: false,
        email: 'a@b.com',
        password: 'pw-123',
      });
    const command = await build(OperatorAddCommand, { add });

    await command.run(['a@b.com'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'operator:add',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        password: 'pw-123',
      }),
    );
  });

  it('operator:reset --execute 打印新密码', async () => {
    const reset = jest
      .fn()
      .mockResolvedValue({
        dryRun: false,
        email: 'a@b.com',
        password: 'new-pw',
      });
    const command = await build(OperatorResetCommand, { reset });

    await command.run(['a@b.com'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      command: 'operator:reset',
      password: 'new-pw',
    });
  });

  it('operator:disable 不输出密码', async () => {
    const disable = jest
      .fn()
      .mockResolvedValue({ dryRun: false, email: 'a@b.com' });
    const command = await build(OperatorDisableCommand, { disable });

    await command.run(['a@b.com'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as object;
    expect(printed).toMatchObject({ command: 'operator:disable' });
    expect(printed).not.toHaveProperty('password');
  });

  it('--operator 不是邮箱、缺少 --reason 时抛错且不调用服务', async () => {
    const add = jest.fn();
    const command = await build(OperatorAddCommand, { add });

    await expect(
      command.run(['a@b.com'], { operator: 'nope', reason: REASON }),
    ).rejects.toThrow();
    await expect(
      command.run(['a@b.com'], { operator: OPERATOR, reason: '' }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
