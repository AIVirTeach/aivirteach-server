import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import {
  CheckTokenQuota,
  TOKEN_WEIGHTS,
} from './application/check-token-quota';
import { GetUsageReport } from './application/get-usage-report';
import { USAGE_READ_MODEL } from './application/usage-read-model';
import { USAGE_REPORT_READ_MODEL } from './application/usage-report-read-model';
import type { TokenWeights } from './domain/token-weights';
import { PrismaUsageReadModel } from './infrastructure/prisma-usage-read-model';
import { AdminTokenUsageController } from './interface/admin-token-usage.controller';

@Module({
  controllers: [AdminTokenUsageController],
  providers: [
    { provide: USAGE_READ_MODEL, useClass: PrismaUsageReadModel },
    // 同一个 Prisma 实现同时满足额度检查和运营报表两个端口，复用同一个实例。
    { provide: USAGE_REPORT_READ_MODEL, useExisting: USAGE_READ_MODEL },
    {
      provide: TOKEN_WEIGHTS,
      inject: [ENV],
      useFactory: (env: Env): TokenWeights => ({
        inputCacheHit: env.TOKEN_WEIGHT_CACHE_HIT,
        inputCacheMiss: env.TOKEN_WEIGHT_INPUT_MISS,
        output: env.TOKEN_WEIGHT_OUTPUT,
      }),
    },
    CheckTokenQuota,
    GetUsageReport,
  ],
  // TokenQuotaGuard 由用它的 controller 所在模块实例化，所以这里导出它依赖的用例；
  // 权重也导出，restart 清空对话前要用同一套权重结算已消耗的额度。
  exports: [CheckTokenQuota, TOKEN_WEIGHTS],
})
export class TokenUsageModule {}
