import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Workspace } from '@prisma/client';
import { AllowQueryToken } from '../auth/allow-query-token.decorator';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CreateWorkspaceSchema,
  ExchangeConsoleTokenSchema,
  StopWorkspaceSchema,
  type CreateWorkspaceInput,
  type ExchangeConsoleTokenInput,
  type StopWorkspaceInput,
} from './workspace.schemas';
import { WorkspaceService, type ConsoleSessionResult } from './workspace.service';
import type { GuacamoleToken } from './labs-client';

@ApiTags('Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get(':enrollmentId')
  get(@Param('enrollmentId') enrollmentId: string, @Req() request: AuthenticatedRequest): Promise<Workspace> {
    return this.workspaceService.getForEnrollment(request.auth!.userId, enrollmentId);
  }

  @Post()
  @HttpCode(202)
  @UsePipes(new ZodValidationPipe(CreateWorkspaceSchema))
  create(@Body() body: CreateWorkspaceInput, @Req() request: AuthenticatedRequest): Promise<Workspace> {
    return this.workspaceService.create(request.auth!.userId, body.enrollmentId);
  }

  @Post(':enrollmentId/console-session')
  createConsoleSession(
    @Param('enrollmentId') enrollmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConsoleSessionResult> {
    return this.workspaceService.createConsoleSession(request.auth!.userId, enrollmentId);
  }

  @Post(':enrollmentId/console-session/token')
  exchangeConsoleToken(
    @Param('enrollmentId') enrollmentId: string,
    @Body(new ZodValidationPipe(ExchangeConsoleTokenSchema)) body: ExchangeConsoleTokenInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<GuacamoleToken> {
    return this.workspaceService.exchangeConsoleToken(request.auth!.userId, enrollmentId, body.data);
  }

  // reason=beacon 是 navigator.sendBeacon() 在关标签页时打的（见 JwtAuthGuard 里的 query
  // token 回退）；reason=manual 是"关闭学习环境"按钮打的。两条路径落到同一个 service.stop。
  @Post(':enrollmentId/stop')
  @HttpCode(200)
  @AllowQueryToken()
  stop(
    @Param('enrollmentId') enrollmentId: string,
    @Body(new ZodValidationPipe(StopWorkspaceSchema)) body: StopWorkspaceInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Workspace> {
    return this.workspaceService.stop(request.auth!.userId, enrollmentId, body.reason);
  }

  @Post(':enrollmentId/start')
  @HttpCode(200)
  start(@Param('enrollmentId') enrollmentId: string, @Req() request: AuthenticatedRequest): Promise<Workspace> {
    return this.workspaceService.start(request.auth!.userId, enrollmentId);
  }

  // 客户端每 60 秒调一次，页面可见且有焦点时才调；用来刷新 lastSeenAt，供空闲兜底扫描判断。
  @Post(':enrollmentId/heartbeat')
  @HttpCode(200)
  heartbeat(@Param('enrollmentId') enrollmentId: string, @Req() request: AuthenticatedRequest): Promise<Workspace> {
    return this.workspaceService.heartbeat(request.auth!.userId, enrollmentId);
  }
}
