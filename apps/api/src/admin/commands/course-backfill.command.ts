import { Command, CommandRunner, Option } from 'nest-commander';
import { AuditActorType, type Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';
import { ContentModelBackfillService } from '../backfill/content-model-backfill.service';

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
  ) {
    super();
  }

  async run(_inputs: string[], options: CourseBackfillOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const execute = Boolean(options.execute);
    const report = await this.backfill.run({ execute });

    if (execute) {
      const metadata: Prisma.InputJsonObject = {
        report: {
          bodies: {
            filled: report.bodies.filled,
            unresolved: report.bodies.unresolved.map(({ lessonId, reason }) => ({
              lessonId,
              reason,
            })),
          },
          progress: {
            filled: report.progress.filled,
            total: report.progress.total,
          },
        },
      };
      await this.audit.record({
        actor: { type: AuditActorType.OPERATOR, id: operator },
        action: 'admin.backfillContentModel',
        success: true,
        targetType: 'CourseVersion',
        reason,
        metadata,
      });
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
