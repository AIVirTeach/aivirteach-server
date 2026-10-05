import { z } from 'zod';

const DEFAULT_RANGE_MS = 7 * 86_400_000;

// 时间区间是左闭右开 [from, to)。省略 to = 现在，省略 from = to 往前 7 天。
export const UsageReportQuerySchema = z
  .object({
    groupBy: z.enum(['user', 'course', 'day']).default('user'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .transform(({ groupBy, from, to }) => {
    const end = to ?? new Date();
    return {
      groupBy,
      from: from ?? new Date(end.getTime() - DEFAULT_RANGE_MS),
      to: end,
    };
  })
  .refine((query) => query.from < query.to, {
    message: 'from 必须早于 to',
    path: ['from'],
  });

export type UsageReportQueryInput = z.infer<typeof UsageReportQuerySchema>;
