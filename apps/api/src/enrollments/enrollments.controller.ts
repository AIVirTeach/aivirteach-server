import {
  Body,
  Put,
  Controller,
  Param,
  Post,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { CompletionCommand, ReadingCommand } from './enrollments.service';
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
  ): Promise<EnrollmentResponse> {
    return this.enrollmentsService.restart(request.auth!.userId, slug);
  }

  @Get('me/enrollments')
  myEnrollments(
    @Req() request: AuthenticatedRequest,
  ): Promise<EnrollmentResponse[]> {
    return this.enrollmentsService.listForUser(request.auth!.userId);
  }

  @Post('lessons/:lessonId/complete')
  async completeLesson(
    @Param('lessonId') lessonId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ enrollment: EnrollmentResponse }> {
    const enrollment = await this.enrollmentsService.completeLesson(
      request.auth!.userId,
      lessonId,
    );
    return { enrollment };
  }
}
