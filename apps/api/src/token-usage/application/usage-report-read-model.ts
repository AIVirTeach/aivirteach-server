import type { TokenUsage } from '../domain/token-usage';

export type UsageGroupBy = 'user' | 'course' | 'day';

export interface UsageReportQuery {
  from: Date;
  to: Date;
  groupBy: UsageGroupBy;
}

// 一个分组内的原始汇总。meteredTurns = 带 usage 的 Agent 回复数；unmeteredTurns = 真实
// Agent 回复（contextRef 非空）但没带 usage 的条数，运营据此判断数字有没有被低估。
export interface UsageAggregate {
  key: string;
  label: string;
  usage: TokenUsage;
  meteredTurns: number;
  unmeteredTurns: number;
}

// 运营报表的读端口，跟额度检查用的 UsageReadModel 分开，两边各自演进。
export interface UsageReportReadModel {
  report(query: UsageReportQuery): Promise<UsageAggregate[]>;
  sumGrantedTokensByUser(userIds: string[]): Promise<Map<string, number>>;
  // 全期（不受报表时间窗口限制）的用量，用来算和 Guard 同口径的余额。
  sumUsageByUser(userIds: string[]): Promise<Map<string, TokenUsage>>;
}

export const USAGE_REPORT_READ_MODEL = Symbol('USAGE_REPORT_READ_MODEL');
