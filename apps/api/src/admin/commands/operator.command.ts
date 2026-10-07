import { Command, CommandRunner, Option } from 'nest-commander';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';
import {
  OperatorAdminService,
  type OperatorChangeContext,
  type OperatorChangeResult,
} from '../operator-admin.service';

interface OperatorCommandOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

// 三个命令的流程相同：校验 --operator/--reason → 调服务 → 打印 JSON。
// 新密码只会出现在 --execute 的这一次输出里，dry-run 不生成密码。
async function runOperatorCommand(
  command: string,
  email: string,
  options: OperatorCommandOptions,
  action: (
    email: string,
    ctx: OperatorChangeContext,
  ) => Promise<OperatorChangeResult>,
): Promise<void> {
  const operator = OperatorSchema.parse(options.operator);
  const reason = ReasonSchema.parse(options.reason);
  const result = await action(email, {
    operator,
    reason,
    execute: !!options.execute,
  });

  console.log(
    JSON.stringify({
      command,
      dryRun: result.dryRun,
      operator,
      reason,
      email: result.email,
      ...(result.dryRun
        ? { note: '加 --execute 才会真正写库' }
        : result.password
          ? { password: result.password }
          : {}),
    }),
  );
}

@Command({
  name: 'operator:add',
  arguments: '<email>',
  description: '添加一个运营账号（随机密码，只显示一次）',
})
export class OperatorAddCommand extends CommandRunner {
  constructor(private readonly operators: OperatorAdminService) {
    super();
  }

  run(inputs: string[], options: OperatorCommandOptions): Promise<void> {
    return runOperatorCommand(
      'operator:add',
      inputs[0],
      options,
      (email, ctx) => this.operators.add(email, ctx),
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

@Command({
  name: 'operator:reset',
  arguments: '<email>',
  description: '重置运营密码（旧登录立即失效，只显示一次新密码）',
})
export class OperatorResetCommand extends CommandRunner {
  constructor(private readonly operators: OperatorAdminService) {
    super();
  }

  run(inputs: string[], options: OperatorCommandOptions): Promise<void> {
    return runOperatorCommand(
      'operator:reset',
      inputs[0],
      options,
      (email, ctx) => this.operators.reset(email, ctx),
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

@Command({
  name: 'operator:disable',
  arguments: '<email>',
  description: '停用运营账号',
})
export class OperatorDisableCommand extends CommandRunner {
  constructor(private readonly operators: OperatorAdminService) {
    super();
  }

  run(inputs: string[], options: OperatorCommandOptions): Promise<void> {
    return runOperatorCommand(
      'operator:disable',
      inputs[0],
      options,
      (email, ctx) => this.operators.disable(email, ctx),
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
