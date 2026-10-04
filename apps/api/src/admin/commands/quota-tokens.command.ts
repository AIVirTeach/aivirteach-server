import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

// QuotaLedger.tokensDelta 是 32 位 Int，超过会在 --execute 写库时才报晦涩的 Prisma 错误。
const MAX_GRANT_TOKENS = 2_147_483_647;

interface QuotaGrantTokensOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'quota:grant-tokens',
  arguments: '<email> <tokens>',
  description: '给用户发放 AI 助教 token 额度（按加权后的额度单位计）',
})
export class QuotaGrantTokensCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: QuotaGrantTokensOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [email, tokensRaw] = inputs;
    // Number() 而不是 parseInt：parseInt('1.5') 会静默截成 1，'12abc' 会截成 12。
    const tokens = Number(tokensRaw);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new Error(`token 数必须是正整数，收到：${tokensRaw}`);
    }
    if (tokens > MAX_GRANT_TOKENS) {
      throw new Error(
        `token 数不能超过 ${MAX_GRANT_TOKENS}，收到：${tokensRaw}`,
      );
    }

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'quota:grant-tokens',
          dryRun: true,
          operator,
          reason,
          email,
          tokens,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const entry = await this.admin.grantTokenQuota(
      email,
      tokens,
      operator,
      reason,
    );

    console.log(
      JSON.stringify({
        command: 'quota:grant-tokens',
        dryRun: false,
        operator,
        reason,
        email,
        tokensDelta: entry.tokensDelta,
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
