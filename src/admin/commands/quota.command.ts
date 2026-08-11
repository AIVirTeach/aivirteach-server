import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface QuotaGrantOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'quota:grant',
  arguments: '<email> <minutes>',
  description: '给用户发放运行额度（分钟）',
})
export class QuotaGrantCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: QuotaGrantOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [email, minutesRaw] = inputs;
    const minutes = Number.parseInt(minutesRaw, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new Error(`分钟数必须是正整数，收到：${minutesRaw}`);
    }

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'quota:grant',
          dryRun: true,
          operator,
          reason,
          email,
          minutes,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const entry = await this.admin.grantQuota(email, minutes, operator, reason);

    console.log(
      JSON.stringify({
        command: 'quota:grant',
        dryRun: false,
        operator,
        reason,
        email,
        minutesDelta: entry.minutesDelta,
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
