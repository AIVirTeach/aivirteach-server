import { Inject, Injectable } from '@nestjs/common';
import {
  evaluateTokenQuota,
  type TokenQuotaVerdict,
} from '../domain/token-quota';
import {
  weightedConsumption,
  type TokenWeights,
} from '../domain/token-weights';
import { USAGE_READ_MODEL, type UsageReadModel } from './usage-read-model';

export const TOKEN_WEIGHTS = Symbol('TOKEN_WEIGHTS');

@Injectable()
export class CheckTokenQuota {
  constructor(
    @Inject(USAGE_READ_MODEL) private readonly readModel: UsageReadModel,
    @Inject(TOKEN_WEIGHTS) private readonly weights: TokenWeights,
  ) {}

  async execute(userId: string): Promise<TokenQuotaVerdict> {
    const [granted, usage] = await Promise.all([
      this.readModel.sumGrantedTokens(userId),
      this.readModel.sumUsage(userId),
    ]);
    return evaluateTokenQuota({
      granted,
      consumed: weightedConsumption(usage, this.weights),
    });
  }
}
