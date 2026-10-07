import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OperatorAuthGuard } from '../../operator-auth/operator-auth.guard';
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
@UseGuards(OperatorAuthGuard)
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
