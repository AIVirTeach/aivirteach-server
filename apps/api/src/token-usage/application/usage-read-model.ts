import type { TokenUsage } from '../domain/token-usage';

// application 层依赖的读端口，由 infrastructure 层用 Prisma 实现。
export interface UsageReadModel {
  // 该用户所有 Agent 回复上记录的 token 之和（空列按 0 计）。
  sumUsage(userId: string): Promise<TokenUsage>;
  // 该用户累计发放的 token 额度（QuotaLedger.tokensDelta 之和）。
  sumGrantedTokens(userId: string): Promise<number>;
}

export const USAGE_READ_MODEL = Symbol('USAGE_READ_MODEL');
