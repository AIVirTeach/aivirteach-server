import { ContentModelBackfillService } from '../backfill/content-model-backfill.service';
import { AuditService } from '../../audit/audit.service';
import { CourseBackfillCommand } from './course-backfill.command';

describe('CourseBackfillCommand', () => {
  const report = { bodies: { filled: 2, unresolved: [] }, progress: { filled: 1, total: 1 } };
  let service: { run: jest.Mock };
  let audit: { record: jest.Mock };
  let command: CourseBackfillCommand;
  let log: jest.SpyInstance;

  beforeEach(() => {
    service = { run: jest.fn().mockResolvedValue(report) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    command = new CourseBackfillCommand(service as unknown as ContentModelBackfillService, audit as unknown as AuditService);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('dry-run 输出 JSON 报告且不记录执行审计', async () => {
    await command.run([], { operator: 'ops@example.com', reason: '校验' });
    expect(service.run).toHaveBeenCalledWith({ execute: false });
    expect(audit.record).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ command: 'course:backfill-content-model', dryRun: true, operator: 'ops@example.com', reason: '校验', ...report }));
  });

  it('仅 execute 时执行写库并记审计', async () => {
    await command.run([], { operator: 'ops@example.com', reason: '迁移回填', execute: true });
    expect(service.run).toHaveBeenCalledWith({ execute: true });
    expect(audit.record).toHaveBeenCalledWith({
      actor: { type: 'OPERATOR', id: 'ops@example.com' },
      action: 'admin.backfillContentModel',
      success: true,
      targetType: 'CourseVersion',
      reason: '迁移回填',
      metadata: { report },
    });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ command: 'course:backfill-content-model', dryRun: false, operator: 'ops@example.com', reason: '迁移回填', ...report }));
  });

  it('operator 和 reason 沿用 schema 校验', async () => {
    await expect(command.run([], { operator: 'bad', reason: 'test' })).rejects.toThrow();
    await expect(command.run([], { operator: 'ops@example.com', reason: '' })).rejects.toThrow();
    expect(service.run).not.toHaveBeenCalled();
  });
});
