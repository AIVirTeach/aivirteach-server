import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabsClient } from './labs-client';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [AuthModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, WorkspaceGateway, LabsClient],
})
export class WorkspaceModule {}
