export type UpstreamErrorTier = 'retryable' | 'unavailable';

export type UpstreamErrorMessages = Record<UpstreamErrorTier, string>;

// 携带分档结果的 Error，供调用方（目前是 WorkspaceService.stopWorkspace）区分瞬时失败
// 和永久失败——只看 message 文案区分不出来，之前 sweepIdle 对着一个 404 的 VM 无限重试
// 就是因为这个分类信息在 LabsClient.assertOk() 里被丢弃了。
export class UpstreamError extends Error {
  constructor(message: string, readonly tier: UpstreamErrorTier) {
    super(message);
    this.name = 'UpstreamError';
  }
}

// 408/429/5xx 是瞬时性问题，提示重试有意义；其余（401/403/404 等）通常是权限或配置问题，
// 重试大概率没用，应该提示联系客服而不是让用户反复重试。
export function classifyUpstreamStatus(status: number): UpstreamErrorTier {
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'unavailable';
}
