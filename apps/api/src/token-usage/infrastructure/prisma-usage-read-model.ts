import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { UsageReadModel } from '../application/usage-read-model';
import type {
  UsageAggregate,
  UsageGroupBy,
  UsageReportQuery,
  UsageReportReadModel,
} from '../application/usage-report-read-model';
import type { TokenUsage } from '../domain/token-usage';

// 只能是这三个固定片段，不拼接任何外部输入，没有注入面。
// "createdAt" 是不带时区的 timestamp（Prisma 存的是 UTC），所以 to_char 直接得到 UTC 日期。
const GROUP_EXPRESSIONS: Record<
  UsageGroupBy,
  { key: Prisma.Sql; label: Prisma.Sql }
> = {
  user: { key: Prisma.sql`e."userId"`, label: Prisma.sql`u."email"` },
  course: { key: Prisma.sql`e."courseId"`, label: Prisma.sql`co."slug"` },
  day: {
    key: Prisma.sql`to_char(c."createdAt", 'YYYY-MM-DD')`,
    label: Prisma.sql`to_char(c."createdAt", 'YYYY-MM-DD')`,
  },
};

interface ReportRow {
  key: string;
  label: string;
  hit: number;
  miss: number;
  output: number;
  metered: number;
  unmetered: number;
}

interface UserUsageRow {
  userId: string;
  hit: number;
  miss: number;
  output: number;
}

@Injectable()
export class PrismaUsageReadModel
  implements UsageReadModel, UsageReportReadModel
{
  constructor(private readonly prisma: PrismaService) {}

  async sumUsage(userId: string): Promise<TokenUsage> {
    const { _sum } = await this.prisma.conversation.aggregate({
      where: { enrollment: { userId } },
      _sum: {
        inputCacheHitTokens: true,
        inputCacheMissTokens: true,
        outputTokens: true,
      },
    });
    return {
      inputCacheHitTokens: _sum.inputCacheHitTokens ?? 0,
      inputCacheMissTokens: _sum.inputCacheMissTokens ?? 0,
      outputTokens: _sum.outputTokens ?? 0,
    };
  }

  async sumGrantedTokens(userId: string): Promise<number> {
    const { _sum } = await this.prisma.quotaLedger.aggregate({
      where: { userId },
      _sum: { tokensDelta: true },
    });
    return _sum.tokensDelta ?? 0;
  }

  async report({
    from,
    to,
    groupBy,
  }: UsageReportQuery): Promise<UsageAggregate[]> {
    const { key, label } = GROUP_EXPRESSIONS[groupBy];
    // 参数显式转成 UTC 的 naive timestamp，再跟 naive 的 createdAt 比较，
    // 不依赖数据库会话时区。区间是左闭右开。
    const rows = await this.prisma.$queryRaw<ReportRow[]>(Prisma.sql`
      SELECT
        ${key} AS key,
        ${label} AS label,
        COALESCE(SUM(c."inputCacheHitTokens"), 0)::float8 AS hit,
        COALESCE(SUM(c."inputCacheMissTokens"), 0)::float8 AS miss,
        COALESCE(SUM(c."outputTokens"), 0)::float8 AS output,
        (COUNT(*) FILTER (WHERE c."outputTokens" IS NOT NULL))::int AS metered,
        (COUNT(*) FILTER (WHERE c."outputTokens" IS NULL AND c."contextRef" IS NOT NULL))::int AS unmetered
      FROM "Conversation" c
      JOIN "Enrollment" e ON e."id" = c."enrollmentId"
      JOIN "User" u ON u."id" = e."userId"
      JOIN "Course" co ON co."id" = e."courseId"
      WHERE c."role" = 'ASSISTANT'
        AND c."createdAt" >= (${from}::timestamptz AT TIME ZONE 'UTC')
        AND c."createdAt" < (${to}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY 1, 2
      ORDER BY 1
    `);
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      usage: {
        inputCacheHitTokens: row.hit,
        inputCacheMissTokens: row.miss,
        outputTokens: row.output,
      },
      meteredTurns: row.metered,
      unmeteredTurns: row.unmetered,
    }));
  }

  async sumUsageByUser(userIds: string[]): Promise<Map<string, TokenUsage>> {
    const usage = new Map<string, TokenUsage>();
    if (userIds.length === 0) return usage;
    const rows = await this.prisma.$queryRaw<UserUsageRow[]>(Prisma.sql`
      SELECT
        e."userId" AS "userId",
        COALESCE(SUM(c."inputCacheHitTokens"), 0)::float8 AS hit,
        COALESCE(SUM(c."inputCacheMissTokens"), 0)::float8 AS miss,
        COALESCE(SUM(c."outputTokens"), 0)::float8 AS output
      FROM "Conversation" c
      JOIN "Enrollment" e ON e."id" = c."enrollmentId"
      WHERE e."userId" IN (${Prisma.join(userIds)})
      GROUP BY e."userId"
    `);
    for (const row of rows) {
      usage.set(row.userId, {
        inputCacheHitTokens: row.hit,
        inputCacheMissTokens: row.miss,
        outputTokens: row.output,
      });
    }
    return usage;
  }

  async sumGrantedTokensByUser(
    userIds: string[],
  ): Promise<Map<string, number>> {
    const grouped = await this.prisma.quotaLedger.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _sum: { tokensDelta: true },
    });
    const granted = new Map(userIds.map((id) => [id, 0]));
    for (const row of grouped)
      granted.set(row.userId, row._sum.tokensDelta ?? 0);
    return granted;
  }
}
