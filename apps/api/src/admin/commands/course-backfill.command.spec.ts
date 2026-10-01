import { ContentModelBackfillService } from '../backfill/content-model-backfill.service';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseBackfillCommand } from './course-backfill.command';

describe('CourseBackfillCommand', () => {
  const report = {
    bodies: { filled: 2, unresolved: [] },
    progress: { filled: 1, total: 1 },
    content: {
      filled: 3,
      skipped: [],
      reports: [],
      pendingBody: [
        { lessonId: 'pending-lesson', reason: '版本没有 sourceMarkdown' },
      ],
    },
  };
  let service: { prepare: jest.Mock; apply: jest.Mock };
  let audit: { record: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  let transaction: object;
  let persistedWrites: string[];
  let command: CourseBackfillCommand;
  let log: jest.SpyInstance;

  beforeEach(() => {
    service = {
      prepare: jest.fn().mockResolvedValue({ report, plan: true }),
      apply: jest.fn(async (_plan: unknown, tx?: { writes: string[] }) => {
        tx?.writes.push('backfill write');
        return report;
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    transaction = {};
    persistedWrites = [];
    prisma = {
      $transaction: jest.fn(async (callback: (tx: object) => unknown) => {
        const tx = { writes: [] as string[] };
        transaction = tx;
        const result = await callback(tx);
        persistedWrites.push(...tx.writes);
        return result;
      }),
    };
    command = new CourseBackfillCommand(
      service as unknown as ContentModelBackfillService,
      audit as unknown as AuditService,
      prisma as unknown as PrismaService,
    );
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('dry-run 输出 JSON 报告且不记录执行审计', async () => {
    await command.run([], { operator: 'ops@example.com', reason: '校验' });
    expect(service.prepare).toHaveBeenCalledTimes(1);
    expect(service.apply).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:backfill-content-model',
        dryRun: true,
        operator: 'ops@example.com',
        reason: '校验',
        ...report,
      }),
    );
  });

  it('仅 execute 时执行写库并记审计', async () => {
    await command.run([], {
      operator: 'ops@example.com',
      reason: '迁移回填',
      execute: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 120_000,
    });
    expect(service.prepare).toHaveBeenCalledTimes(1);
    expect(service.apply).toHaveBeenCalledWith(
      { report, plan: true },
      transaction,
    );
    expect(audit.record).toHaveBeenCalledWith(
      {
        actor: { type: 'OPERATOR', id: 'ops@example.com' },
        action: 'admin.backfillContentModel',
        success: true,
        targetType: 'CourseVersion',
        reason: '迁移回填',
        metadata: {
          report: {
            ...report,
            bodies: { ...report.bodies },
            progress: { ...report.progress },
            content: { ...report.content },
          },
        },
      },
      transaction,
    );
    expect(persistedWrites).toEqual(['backfill write']);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:backfill-content-model',
        dryRun: false,
        operator: 'ops@example.com',
        reason: '迁移回填',
        ...report,
      }),
    );
  });

  it('审计失败会使事务失败并阻止成功报告输出', async () => {
    const failure = new Error('audit write failed');
    audit.record.mockRejectedValue(failure);

    await expect(
      command.run([], {
        operator: 'ops@example.com',
        reason: '迁移回填',
        execute: true,
      }),
    ).rejects.toBe(failure);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(service.prepare).toHaveBeenCalledTimes(1);
    expect(service.apply).toHaveBeenCalledWith(
      { report, plan: true },
      transaction,
    );
    expect(audit.record).toHaveBeenCalledWith(expect.any(Object), transaction);
    expect(log).not.toHaveBeenCalled();
    expect(persistedWrites).toEqual([]);
  });

  it('operator 和 reason 沿用 schema 校验', async () => {
    await expect(
      command.run([], { operator: 'bad', reason: 'test' }),
    ).rejects.toThrow();
    await expect(
      command.run([], { operator: 'ops@example.com', reason: '' }),
    ).rejects.toThrow();
    expect(service.prepare).not.toHaveBeenCalled();
  });
});
