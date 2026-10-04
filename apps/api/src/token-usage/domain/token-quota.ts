export interface TokenQuotaVerdict {
  verdict: 'allowed' | 'exhausted';
  balance: number;
}

// 余额 = 累计发放 - 累计消耗。余额为 0 也算用尽；并发超额时可能为负，如实返回。
export function evaluateTokenQuota(input: {
  granted: number;
  consumed: number;
}): TokenQuotaVerdict {
  const balance = input.granted - input.consumed;
  return { verdict: balance > 0 ? 'allowed' : 'exhausted', balance };
}
