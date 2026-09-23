export type UpstreamErrorTier = 'retryable' | 'unavailable';

export type UpstreamErrorMessages = Record<UpstreamErrorTier, string>;

// 408/429/5xx 是瞬时性问题，提示重试有意义；其余（401/403/404 等）通常是权限或配置问题，
// 重试大概率没用，应该提示联系客服而不是让用户反复重试。
export function classifyUpstreamStatus(status: number): UpstreamErrorTier {
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'unavailable';
}
