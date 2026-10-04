import type { TokenUsage } from './token-usage';

// 三类 token 折算成额度单位的权重，以未命中输入为基准（通常 = 1）。
export interface TokenWeights {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

// 向上取整：零头也要扣，否则大量小请求会永远扣不到额度。
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
