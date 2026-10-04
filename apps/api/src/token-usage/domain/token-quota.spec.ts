import { evaluateTokenQuota } from './token-quota';

describe('evaluateTokenQuota', () => {
  it('余额为正 -> allowed', () => {
    expect(evaluateTokenQuota({ granted: 1000, consumed: 999 })).toEqual({
      verdict: 'allowed',
      balance: 1,
    });
  });

  it('余额恰好为 0 -> exhausted（已无额度可用）', () => {
    expect(evaluateTokenQuota({ granted: 1000, consumed: 1000 })).toEqual({
      verdict: 'exhausted',
      balance: 0,
    });
  });

  it('并发超额导致余额为负 -> exhausted，余额如实返回负数', () => {
    expect(evaluateTokenQuota({ granted: 1000, consumed: 1200 })).toEqual({
      verdict: 'exhausted',
      balance: -200,
    });
  });

  it('从未发放过额度 -> exhausted', () => {
    expect(evaluateTokenQuota({ granted: 0, consumed: 0 })).toEqual({
      verdict: 'exhausted',
      balance: 0,
    });
  });
});
