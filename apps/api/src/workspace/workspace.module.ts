import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { LabsClient } from './labs-client';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceIdleSweepInterceptor } from './workspace-idle-sweep.interceptor';
import { WorkspaceService } from './workspace.service';

// WorkspaceIdleSweepInterceptor 注册成 APP_INTERCEPTOR 挂在这个 module 上而不是改
// JwtAuthGuard（AuthModule 里）：AuthModule 不该反过来依赖 WorkspaceModule，见
// jwt-auth.guard.ts 的职责边界。WorkspaceModule 本身已经被 AppModule 引入，
// 所以这里注册的全局拦截器照样对全站请求生效。
@Module({
  imports: [AuthModule],
  controllers: [WorkspaceController],
  providers: [
    WorkspaceService,
    WorkspaceGateway,
    LabsClient,
    { provide: APP_INTERCEPTOR, useClass: WorkspaceIdleSweepInterceptor },
  ],
})
export class WorkspaceModule {}
