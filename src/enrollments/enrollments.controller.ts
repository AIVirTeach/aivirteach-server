import { Controller, Param, Post, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { EnrollmentsService, type EnrollmentResponse } from './enrollments.service';

@ApiTags('Enrollments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

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
  myEnrollments(@Req() request: AuthenticatedRequest): Promise<EnrollmentResponse[]> {
    return this.enrollmentsService.listForUser(request.auth!.userId);
  }

  @Post('lessons/:lessonId/complete')
  completeLesson(
    @Param('lessonId') lessonId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.enrollmentsService.completeLesson(request.auth!.userId, lessonId);
  }
}
