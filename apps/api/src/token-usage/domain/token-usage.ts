// 一次 Agent 调用消耗的 token，按计费口径分三类。三类之和 = prompt + completion，
// 不单独存 total；推理 token 已包含在 outputTokens 里，不单列。
export interface TokenUsage {
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  outputTokens: number;
}
