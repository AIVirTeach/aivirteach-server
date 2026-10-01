import { Command, CommandRunner, Option } from 'nest-commander';
import { AuditActorType, type Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';
import {
  ContentModelBackfillService,
  type BackfillReport,
} from '../backfill/content-model-backfill.service';

interface CourseBackfillOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'course:backfill-content-model',
  description: '回填课程课时正文与学员进度 contentId',
})
export class CourseBackfillCommand extends CommandRunner {
  constructor(
    private readonly backfill: ContentModelBackfillService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async run(_inputs: string[], options: CourseBackfillOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const execute = Boolean(options.execute);
    const plan = await this.backfill.prepare();
    let report: BackfillReport;

    if (execute) {
      // Conversion and asset reads are complete before opening the write-and-audit transaction.
      report = await this.prisma.$transaction(
        async (transaction) => {
          const result = await this.backfill.apply(plan, transaction);
          const metadata: Prisma.InputJsonObject = {
            report: {
              bodies: {
                filled: result.bodies.filled,
                unresolved: result.bodies.unresolved.map(
                  ({ lessonId, reason }) => ({ lessonId, reason }),
                ),
              },
              progress: {
                filled: result.progress.filled,
                total: result.progress.total,
              },
              content: {
                filled: result.content.filled,
                skipped: result.content.skipped.map(({ lessonId, reason }) => ({
                  lessonId,
                  reason,
                })),
                reports: result.content.reports.map(({ lessonId, issues }) => ({
                  lessonId,
                  issues,
                })),
                pendingBody: result.content.pendingBody.map(
                  ({ lessonId, reason }) => ({ lessonId, reason }),
                ),
              },
            },
          };
          await this.audit.record(
            {
              actor: { type: AuditActorType.OPERATOR, id: operator },
              action: 'admin.backfillContentModel',
              success: true,
              targetType: 'CourseVersion',
              reason,
              metadata,
            },
            transaction,
          );
          return result;
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    } else {
      report = plan.report;
    }

    console.log(
      JSON.stringify({
        command: 'course:backfill-content-model',
        dryRun: !execute,
        operator,
        reason,
        ...report,
      }),
    );
  }

  @Option({
    flags: '-o, --operator <operator>',
    description: '执行本次操作的人（邮箱）',
    required: true,
  })
  parseOperator(value: string): string {
    return value;
  }

  @Option({
    flags: '-r, --reason <reason>',
    description: '本次操作的原因',
    required: true,
  })
  parseReason(value: string): string {
    return value;
  }

  @Option({
    flags: '-e, --execute',
    description: '真正执行写库；不加这个参数只打印统计（dry-run）',
  })
  parseExecute(): boolean {
    return true;
  }
}
