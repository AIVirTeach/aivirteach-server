import { Body, Controller, Get, HttpCode, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { RecordPracticeSchema, type RecordPracticeInput } from './dashboard.schemas';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('dashboard')
  dashboard(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.getDashboard(request.auth!.userId);
  }

  @Get('notifications')
  notifications(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.listNotifications(request.auth!.userId);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  markAllRead(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.markAllNotificationsRead(request.auth!.userId);
  }

  @Post('practice-sessions')
  @HttpCode(204)
  @UsePipes(new ZodValidationPipe(RecordPracticeSchema))
  recordPractice(
    @Body() body: RecordPracticeInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.dashboardService.recordPractice(request.auth!.userId, body.minutes);
  }
}
