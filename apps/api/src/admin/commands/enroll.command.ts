import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface EnrollOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'enroll',
  arguments: '<email> <courseSlug>',
  description: '给用户开课',
})
export class EnrollCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: EnrollOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [email, courseSlug] = inputs;

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'enroll',
          dryRun: true,
          operator,
          reason,
          email,
          courseSlug,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    await this.admin.enrollUser(email, courseSlug, operator, reason);

    console.log(
      JSON.stringify({
        command: 'enroll',
        dryRun: false,
        operator,
        reason,
        email,
        courseSlug,
      }),
    );
  }

  @Option({
    flags: '-o, --operator <operator>',
    description: '执行本次操作的人（邮箱）',
    required: true,
  })
  parseOperator(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --reason <reason>',
    description: '本次操作的原因',
    required: true,
  })
  parseReason(val: string): string {
    return val;
  }

  @Option({
    flags: '-e, --execute',
    description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）',
  })
  parseExecute(): boolean {
    return true;
  }
}
