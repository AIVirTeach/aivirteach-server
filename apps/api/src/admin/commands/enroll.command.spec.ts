import { Test } from '@nestjs/testing';
import { AdminService } from '../admin.service';
import { EnrollCommand } from './enroll.command';

const OPERATOR = 'ops@example.com';
const REASON = '新学员批次';

const buildCommand = async (admin: Partial<AdminService> = {}) => {
  const moduleRef = await Test.createTestingModule({
    providers: [EnrollCommand, { provide: AdminService, useValue: admin }],
  }).compile();
  return moduleRef.get(EnrollCommand);
};

describe('EnrollCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService', async () => {
    const enrollUser = jest.fn();
    const command = await buildCommand({ enrollUser });

    await command.run(['a@b.com', 'n8n'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(enrollUser).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'enroll',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        courseSlug: 'n8n',
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService', async () => {
    const enrollUser = jest.fn().mockResolvedValue({ id: 'enr_1' });
    const command = await buildCommand({ enrollUser });

    await command.run(['a@b.com', 'n8n'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(enrollUser).toHaveBeenCalledWith('a@b.com', 'n8n', OPERATOR, REASON);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'enroll',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        email: 'a@b.com',
        courseSlug: 'n8n',
      }),
    );
  });

  it('reason 为空时拒绝，不调用 AdminService', async () => {
    const enrollUser = jest.fn();
    const command = await buildCommand({ enrollUser });

    await expect(
      command.run(['a@b.com', 'n8n'], { operator: OPERATOR, reason: '' }),
    ).rejects.toThrow('reason 不能为空');
    expect(enrollUser).not.toHaveBeenCalled();
  });
});
