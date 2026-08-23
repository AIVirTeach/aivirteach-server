import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Workspace } from '@prisma/client';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CreateWorkspaceSchema, type CreateWorkspaceInput } from './workspace.schemas';
import { WorkspaceService } from './workspace.service';

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
}
