import type { TokenUsage } from '../domain/token-usage';
import type { TokenWeights } from '../domain/token-weights';
import { GetUsageReport } from './get-usage-report';
import type {
  UsageAggregate,
  UsageReportReadModel,
} from './usage-report-read-model';

const weights: TokenWeights = {
  inputCacheHit: 0.1,
  inputCacheMiss: 1,
  output: 4,
};
const range = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-10-08T00:00:00Z'),
};

const aggregate = (
  overrides: Partial<UsageAggregate> = {},
): UsageAggregate => ({
  key: 'u1',
  label: 'a@b.com',
  usage: {
    inputCacheHitTokens: 1000,
    inputCacheMissTokens: 200,
    outputTokens: 50,
  },
  meteredTurns: 3,
  unmeteredTurns: 1,
  ...overrides,
});

const noUsage: TokenUsage = {
  inputCacheHitTokens: 0,
  inputCacheMissTokens: 0,
  outputTokens: 0,
};

function fakeReadModel(
  rows: UsageAggregate[],
  granted: Record<string, number> = {},
  lifetime: Record<string, TokenUsage> = {},
) {
  const calls = {
    report: [] as unknown[],
    granted: [] as string[][],
    lifetime: [] as string[][],
  };
  const readModel: UsageReportReadModel = {
    report: (query) => {
      calls.report.push(query);
      return Promise.resolve(rows);
    },
    sumGrantedTokensByUser: (userIds) => {
      calls.granted.push(userIds);
      return Promise.resolve(
        new Map(userIds.map((id) => [id, granted[id] ?? 0])),
      );
    },
    sumUsageByUser: (userIds) => {
      calls.lifetime.push(userIds);
      return Promise.resolve(
        new Map(userIds.map((id) => [id, lifetime[id] ?? noUsage])),
      );
    },
  };
  return { readModel, calls };
}

describe('GetUsageReport', () => {
  it('每行带三类原始 token、加权消耗和覆盖率计数', async () => {
    const { readModel } = fakeReadModel([aggregate()]);
    const rows = await new GetUsageReport(readModel, weights).execute({
      ...range,
      groupBy: 'course',
    });

    expect(rows).toEqual([
      {
        key: 'u1',
        label: 'a@b.com',
        inputCacheHitTokens: 1000,
        inputCacheMissTokens: 200,
        outputTokens: 50,
        weightedConsumption: 100 + 200 + 200,
        meteredTurns: 3,
        unmeteredTurns: 1,
      },
    ]);
  });

  it('按用户分组时附带累计发放额度和余额', async () => {
    const sameAsWindow = aggregate().usage;
    const { readModel, calls } = fakeReadModel(
      [aggregate({ key: 'u1' }), aggregate({ key: 'u2' })],
      { u1: 1000 },
      { u1: sameAsWindow, u2: sameAsWindow },
    );
    const rows = await new GetUsageReport(readModel, weights).execute({
      ...range,
      groupBy: 'user',
    });

    expect(calls.granted).toEqual([['u1', 'u2']]);
    expect(calls.lifetime).toEqual([['u1', 'u2']]);
    expect(rows[0]).toMatchObject({
      key: 'u1',
      grantedTokens: 1000,
      lifetimeConsumption: 500,
      balance: 500,
    });
    // 没发放过额度的用户：发放 0，余额为负（已超支）
    expect(rows[1]).toMatchObject({
      key: 'u2',
      grantedTokens: 0,
      balance: -500,
    });
  });

  it('余额按全期消耗计算（和 Guard 同口径），不受报表时间窗口影响', async () => {
    // 窗口内只花了 500，但全期花了 5000：Guard 看到的是 5000，所以余额必须是 1000-5000。
    const { readModel } = fakeReadModel(
      [aggregate({ key: 'u1' })],
      { u1: 1000 },
      {
        u1: {
          inputCacheHitTokens: 10_000,
          inputCacheMissTokens: 2_000,
          outputTokens: 500,
        },
      },
    );
    const [row] = await new GetUsageReport(readModel, weights).execute({
      ...range,
      groupBy: 'user',
    });

    expect(row.weightedConsumption).toBe(500); // 窗口内
    expect(row.lifetimeConsumption).toBe(1000 + 2000 + 2000);
    expect(row.balance).toBe(1000 - 5000);
  });

  it.each(['course', 'day'] as const)(
    '按 %s 分组时不查发放额度，也不带余额字段',
    async (groupBy) => {
      const { readModel, calls } = fakeReadModel([aggregate()]);
      const [row] = await new GetUsageReport(readModel, weights).execute({
        ...range,
        groupBy,
      });

      expect(calls.granted).toEqual([]);
      expect(calls.lifetime).toEqual([]);
      expect(row).not.toHaveProperty('grantedTokens');
      expect(row).not.toHaveProperty('lifetimeConsumption');
      expect(row).not.toHaveProperty('balance');
    },
  );

  it('把时间范围和分组方式原样交给读模型', async () => {
    const { readModel, calls } = fakeReadModel([]);
    await new GetUsageReport(readModel, weights).execute({
      ...range,
      groupBy: 'day',
    });
    expect(calls.report).toEqual([{ ...range, groupBy: 'day' }]);
  });

  it('没有数据时返回空数组，用户分组也不查发放额度', async () => {
    const { readModel, calls } = fakeReadModel([]);
    await expect(
      new GetUsageReport(readModel, weights).execute({
        ...range,
        groupBy: 'user',
      }),
    ).resolves.toEqual([]);
    expect(calls.granted).toEqual([]);
    expect(calls.lifetime).toEqual([]);
  });
});
