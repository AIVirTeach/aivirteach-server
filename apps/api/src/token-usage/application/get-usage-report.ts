import { Inject, Injectable } from '@nestjs/common';
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

export interface UsageReportRow {
  key: string;
  label: string;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  outputTokens: number;
  weightedConsumption: number;
  meteredTurns: number;
  unmeteredTurns: number;
  // 仅按用户分组时有：累计发放的额度和余额（发放 - 加权消耗）。
  grantedTokens?: number;
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
    const granted =
      query.groupBy === 'user' && aggregates.length > 0
        ? await this.readModel.sumGrantedTokensByUser(
            aggregates.map((a) => a.key),
          )
        : null;

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
      if (granted) {
        const grantedTokens = granted.get(aggregate.key) ?? 0;
        row.grantedTokens = grantedTokens;
        row.balance = grantedTokens - consumed;
      }
      return row;
    });
  }
}
