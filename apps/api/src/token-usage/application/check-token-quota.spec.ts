import type { TokenWeights } from '../domain/token-weights';
import { CheckTokenQuota } from './check-token-quota';
import type { UsageReadModel } from './usage-read-model';

const weights: TokenWeights = {
  inputCacheHit: 0.1,
  inputCacheMiss: 1,
  output: 4,
};

function fakeReadModel(state: {
  granted: number;
  usage: {
    inputCacheHitTokens: number;
    inputCacheMissTokens: number;
    outputTokens: number;
  };
}): UsageReadModel {
  return {
    sumGrantedTokens: () => Promise.resolve(state.granted),
    sumUsage: () => Promise.resolve(state.usage),
  };
}

describe('CheckTokenQuota', () => {
  it('发放额度减去加权消耗，余额为正 -> allowed', async () => {
    const check = new CheckTokenQuota(
      fakeReadModel({
        granted: 1000,
        usage: {
          inputCacheHitTokens: 1000,
          inputCacheMissTokens: 200,
          outputTokens: 50,
        },
      }),
      weights,
    );
    // consumed = 100 + 200 + 200 = 500
    await expect(check.execute('u1')).resolves.toEqual({
      verdict: 'allowed',
      balance: 500,
    });
  });

  it('消耗达到发放额度 -> exhausted', async () => {
    const check = new CheckTokenQuota(
      fakeReadModel({
        granted: 500,
        usage: {
          inputCacheHitTokens: 1000,
          inputCacheMissTokens: 200,
          outputTokens: 50,
        },
      }),
      weights,
    );
    await expect(check.execute('u1')).resolves.toEqual({
      verdict: 'exhausted',
      balance: 0,
    });
  });

  it('从未发放过额度 -> exhausted', async () => {
    const check = new CheckTokenQuota(
      fakeReadModel({
        granted: 0,
        usage: {
          inputCacheHitTokens: 0,
          inputCacheMissTokens: 0,
          outputTokens: 0,
        },
      }),
      weights,
    );
    await expect(check.execute('u1')).resolves.toEqual({
      verdict: 'exhausted',
      balance: 0,
    });
  });

  it('按传入的 userId 查询读模型', async () => {
    const seen: string[] = [];
    const readModel: UsageReadModel = {
      sumGrantedTokens: (userId) => {
        seen.push(`granted:${userId}`);
        return Promise.resolve(10);
      },
      sumUsage: (userId) => {
        seen.push(`usage:${userId}`);
        return Promise.resolve({
          inputCacheHitTokens: 0,
          inputCacheMissTokens: 0,
          outputTokens: 0,
        });
      },
    };
    await new CheckTokenQuota(readModel, weights).execute('user-42');
    expect(seen.sort()).toEqual(['granted:user-42', 'usage:user-42']);
  });
});
