import { UsageReportQuerySchema } from './token-usage-report.schemas';

describe('UsageReportQuerySchema', () => {
  afterEach(() => jest.useRealTimers());

  it('全部省略时默认按用户分组、统计最近 7 天', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T00:00:00Z'));
    const parsed = UsageReportQuerySchema.parse({});

    expect(parsed.groupBy).toBe('user');
    expect(parsed.to).toEqual(new Date('2026-10-08T00:00:00Z'));
    expect(parsed.from).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('只给 to 时，from 默认是 to 往前 7 天', () => {
    const parsed = UsageReportQuerySchema.parse({ to: '2026-10-20T00:00:00Z' });
    expect(parsed.from).toEqual(new Date('2026-10-13T00:00:00Z'));
  });

  it('接受 ISO 时间和三种分组方式', () => {
    for (const groupBy of ['user', 'course', 'day']) {
      const parsed = UsageReportQuerySchema.parse({
        from: '2026-10-01',
        to: '2026-10-05',
        groupBy,
      });
      expect(parsed.groupBy).toBe(groupBy);
      expect(parsed.from).toEqual(new Date('2026-10-01'));
    }
  });

  it.each([
    ['未知分组', { groupBy: 'enrollment' }],
    ['无法解析的时间', { from: 'yesterday' }],
    ['from 晚于 to', { from: '2026-10-05', to: '2026-10-01' }],
    ['from 等于 to（空区间）', { from: '2026-10-01', to: '2026-10-01' }],
  ])('%s 时校验失败', (_label, query) => {
    expect(UsageReportQuerySchema.safeParse(query).success).toBe(false);
  });
});
