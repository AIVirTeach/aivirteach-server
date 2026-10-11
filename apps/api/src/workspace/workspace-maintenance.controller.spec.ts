import { UnauthorizedException } from '@nestjs/common';
import { WorkspaceMaintenanceController } from './workspace-maintenance.controller';
import { WorkspaceService } from './workspace.service';
import type { Env } from '../config/env';

describe('WorkspaceMaintenanceController', () => {
  const workspaceService = {
    sweepResets: jest.fn().mockResolvedValue({ attempted: 1, failed: 0 }),
  };

  it('无密钥或错误密钥时拒绝维护请求', () => {
    const withoutSecret = new WorkspaceMaintenanceController(
      workspaceService as unknown as WorkspaceService,
      {} as Env,
    );
    expect(() => withoutSecret.sweep('Bearer guessed')).toThrow(
      UnauthorizedException,
    );

    const configured = new WorkspaceMaintenanceController(
      workspaceService as unknown as WorkspaceService,
      { CRON_SECRET: 'test-secret-at-least-16' } as Env,
    );
    expect(() => configured.sweep('Bearer wrong')).toThrow(
      UnauthorizedException,
    );
    expect(workspaceService.sweepResets).not.toHaveBeenCalled();
  });

  it('正确 Bearer 密钥触发待清理任务扫描', async () => {
    const controller = new WorkspaceMaintenanceController(
      workspaceService as unknown as WorkspaceService,
      { CRON_SECRET: 'test-secret-at-least-16' } as Env,
    );

    await expect(
      controller.sweep('Bearer test-secret-at-least-16'),
    ).resolves.toEqual({ attempted: 1, failed: 0 });

    expect(workspaceService.sweepResets).toHaveBeenCalledTimes(1);
  });
});
