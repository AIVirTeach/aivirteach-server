import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminApiTokenGuard } from '../../admin/admin-api-token.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  GetUsageReport,
  type UsageReportRow,
} from '../application/get-usage-report';
import {
  UsageReportQuerySchema,
  type UsageReportQueryInput,
} from './token-usage-report.schemas';

@ApiTags('Admin Token Usage')
@ApiBearerAuth()
@UseGuards(AdminApiTokenGuard)
@Controller('admin/token-usage')
export class AdminTokenUsageController {
  constructor(private readonly getUsageReport: GetUsageReport) {}

  @Get()
  report(
    @Query(new ZodValidationPipe(UsageReportQuerySchema))
    query: UsageReportQueryInput,
  ): Promise<UsageReportRow[]> {
    return this.getUsageReport.execute(query);
  }
}
