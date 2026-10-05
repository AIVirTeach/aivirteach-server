import { Inject, Injectable } from '@nestjs/common';
import type { TokenUsage } from '../domain/token-usage';
import {
  weightedConsumption,
  type TokenWeights,
} from '../domain/token-weights';
import { TOKEN_WEIGHTS } from './check-token-quota';
import {
  USAGE_REPORT_READ_MODEL,
  type UsageReportQuery,
  type UsageReportReadModel,
} from './usage-report-read-model';

const NO_USAGE: TokenUsage = {
  inputCacheHitTokens: 0,
  inputCacheMissTokens: 0,
  outputTokens: 0,
};

export interface UsageReportRow {
  key: string;
  label: string;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  outputTokens: number;
  weightedConsumption: number;
  meteredTurns: number;
  unmeteredTurns: number;
  // 仅按用户分组时有。weightedConsumption 只统计报表时间窗口，而额度是全期的，
  // 所以余额 = 累计发放 - 全期加权消耗（lifetimeConsumption），和 Guard 判定用的口径一致。
  grantedTokens?: number;
  lifetimeConsumption?: number;
  balance?: number;
}

@Injectable()
export class GetUsageReport {
  constructor(
    @Inject(USAGE_REPORT_READ_MODEL)
    private readonly readModel: UsageReportReadModel,
    @Inject(TOKEN_WEIGHTS) private readonly weights: TokenWeights,
  ) {}

  async execute(query: UsageReportQuery): Promise<UsageReportRow[]> {
    const aggregates = await this.readModel.report(query);
    const userIds =
      query.groupBy === 'user' ? aggregates.map((a) => a.key) : [];
    const [granted, lifetime] =
      userIds.length > 0
        ? await Promise.all([
            this.readModel.sumGrantedTokensByUser(userIds),
            this.readModel.sumUsageByUser(userIds),
          ])
        : [null, null];

    return aggregates.map((aggregate) => {
      const consumed = weightedConsumption(aggregate.usage, this.weights);
      const row: UsageReportRow = {
        key: aggregate.key,
        label: aggregate.label,
        inputCacheHitTokens: aggregate.usage.inputCacheHitTokens,
        inputCacheMissTokens: aggregate.usage.inputCacheMissTokens,
        outputTokens: aggregate.usage.outputTokens,
        weightedConsumption: consumed,
        meteredTurns: aggregate.meteredTurns,
        unmeteredTurns: aggregate.unmeteredTurns,
      };
      if (granted && lifetime) {
        const grantedTokens = granted.get(aggregate.key) ?? 0;
        const lifetimeConsumption = weightedConsumption(
          lifetime.get(aggregate.key) ?? NO_USAGE,
          this.weights,
        );
        row.grantedTokens = grantedTokens;
        row.lifetimeConsumption = lifetimeConsumption;
        row.balance = grantedTokens - lifetimeConsumption;
      }
      return row;
    });
  }
}
