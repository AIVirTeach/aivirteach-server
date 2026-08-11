import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface InviteOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'invite',
  arguments: '<email>',
  description: '邀请一个封测用户',
})
export class InviteCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: InviteOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const email = inputs[0];

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'invite',
          dryRun: true,
          operator,
          reason,
          email,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const result = await this.admin.inviteUser(email, operator, reason);

    console.log(
      JSON.stringify({
        command: 'invite',
        dryRun: false,
        operator,
        reason,
        email: result.email,
        invitationToken: result.invitationToken,
        expiresAt: result.expiresAt.toISOString(),
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
