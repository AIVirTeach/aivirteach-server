import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Workspace } from '@prisma/client';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CreateWorkspaceSchema, ExchangeConsoleTokenSchema, type CreateWorkspaceInput, type ExchangeConsoleTokenInput } from './workspace.schemas';
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
}
