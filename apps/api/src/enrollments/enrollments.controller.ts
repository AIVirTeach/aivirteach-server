import {
  Body,
  Put,
  Controller,
  Param,
  Post,
  Get,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type {
  CompletionCommand,
  ReadingCommand,
  RestartCommand,
  SnapshotCommand,
} from './enrollments.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../auth/jwt-auth.guard';
import {
  EnrollmentsService,
  type EnrollmentResponse,
} from './enrollments.service';

const version = {
  generation: z.number().int().nonnegative(),
  courseVersionId: z.string().min(1).max(200),
};
const completion = z
  .object({
    ...version,
    revision: z.number().int().nonnegative(),
    completed: z.boolean(),
  })
  .strict();
const reading = z
  .object({ ...version, lessonId: z.string().min(1).max(200) })
  .strict();
const restart = z
  .object({
    requestId: z.string().uuid(),
    ...version,
    revision: z.number().int().nonnegative(),
  })
  .strict();
const snapshot = restart;

@ApiTags('Enrollments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @Get('courses/:slug/progress')
  progress(@Param('slug') slug: string, @Req() request: AuthenticatedRequest) {
    return this.enrollmentsService.getProgress(request.auth!.userId, slug);
  }

  @Put('courses/:slug/lessons/:lessonId/progress')
  setProgress(
    @Param('slug') slug: string,
    @Param('lessonId') lessonId: string,
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(completion)) command: CompletionCommand,
  ) {
    return this.enrollmentsService.setLessonProgress(
      request.auth!.userId,
      slug,
      lessonId,
      command,
    );
  }

  @Put('courses/:slug/reading-position')
  setReading(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(reading)) command: ReadingCommand,
  ) {
    return this.enrollmentsService.setReadingPosition(
      request.auth!.userId,
      slug,
      command,
    );
  }

  @Post('courses/:slug/enroll')
  enroll(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<EnrollmentResponse> {
    // Guard 通过后 auth 必然存在。
    return this.enrollmentsService.enroll(request.auth!.userId, slug);
  }

  @Post('courses/:slug/restart')
  restart(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(restart)) command: RestartCommand,
  ): Promise<EnrollmentResponse> {
    return this.enrollmentsService.restart(request.auth!.userId, slug, command);
  }

  @Post('courses/:slug/snapshots')
  createSnapshot(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(snapshot)) command: SnapshotCommand,
  ) {
    return this.enrollmentsService.createSnapshot(
      request.auth!.userId,
      slug,
      command,
    );
  }

  @Get('courses/:slug/snapshots')
  listSnapshots(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
  ) {
    return this.enrollmentsService.listSnapshots(
      request.auth!.userId,
      slug,
      cursor,
    );
  }

  @Get('courses/:slug/snapshots/:snapshotId')
  getSnapshot(
    @Param('slug') slug: string,
    @Param('snapshotId') snapshotId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.enrollmentsService.getSnapshot(
      request.auth!.userId,
      slug,
      snapshotId,
    );
  }

  @Get('me/enrollments')
  myEnrollments(
    @Req() request: AuthenticatedRequest,
  ): Promise<EnrollmentResponse[]> {
    return this.enrollmentsService.listForUser(request.auth!.userId);
  }
}
