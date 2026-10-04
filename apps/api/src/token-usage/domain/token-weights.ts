import type { TokenUsage } from './token-usage';

// 三类 token 折算成额度单位的权重，以未命中输入为基准（通常 = 1）。
export interface TokenWeights {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

// 对汇总后的用量向上取整，只在汇总值上有 < 1 个单位的零头，不是逐请求取整；
// 报表里分组之间各自取整，所以各组之和可能和用户总额差 1 个单位以内。
export function weightedConsumption(
  usage: TokenUsage,
  weights: TokenWeights,
): number {
  return Math.ceil(
    usage.inputCacheHitTokens * weights.inputCacheHit +
      usage.inputCacheMissTokens * weights.inputCacheMiss +
      usage.outputTokens * weights.output,
  );
}
