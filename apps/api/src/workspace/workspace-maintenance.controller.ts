import {
  Controller,
  Get,
  Headers,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { WorkspaceService } from './workspace.service';

@Controller('internal/workspace-maintenance')
export class WorkspaceMaintenanceController {
  constructor(
    private readonly workspaceService: WorkspaceService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  sweep(
    @Headers('authorization') authorization?: string,
  ): Promise<{ attempted: number; failed: number }> {
    if (
      !this.env.CRON_SECRET ||
      authorization !== `Bearer ${this.env.CRON_SECRET}`
    ) {
      throw new UnauthorizedException();
    }
    return this.workspaceService.sweepResets();
  }
}
