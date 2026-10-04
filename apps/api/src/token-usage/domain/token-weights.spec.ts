import { weightedConsumption, type TokenWeights } from './token-weights';

const weights: TokenWeights = {
  inputCacheHit: 0.1,
  inputCacheMiss: 1,
  output: 4,
};

describe('weightedConsumption', () => {
  it('三类 token 按各自权重加权求和', () => {
    const consumed = weightedConsumption(
      {
        inputCacheHitTokens: 1000,
        inputCacheMissTokens: 200,
        outputTokens: 50,
      },
      weights,
    );
    expect(consumed).toBe(100 + 200 + 200);
  });

  it('全零用量扣 0', () => {
    expect(
      weightedConsumption(
        { inputCacheHitTokens: 0, inputCacheMissTokens: 0, outputTokens: 0 },
        weights,
      ),
    ).toBe(0);
  });

  it('结果有小数时向上取整，避免零头永远扣不到', () => {
    // 1 * 0.1 = 0.1 -> 1
    expect(
      weightedConsumption(
        { inputCacheHitTokens: 1, inputCacheMissTokens: 0, outputTokens: 0 },
        weights,
      ),
    ).toBe(1);
  });

  it('缓存命中比未命中输入扣得少，输出扣得最多（同样 100 个 token）', () => {
    const hit = weightedConsumption(
      { inputCacheHitTokens: 100, inputCacheMissTokens: 0, outputTokens: 0 },
      weights,
    );
    const miss = weightedConsumption(
      { inputCacheHitTokens: 0, inputCacheMissTokens: 100, outputTokens: 0 },
      weights,
    );
    const out = weightedConsumption(
      { inputCacheHitTokens: 0, inputCacheMissTokens: 0, outputTokens: 100 },
      weights,
    );
    expect(hit).toBeLessThan(miss);
    expect(miss).toBeLessThan(out);
  });
});
