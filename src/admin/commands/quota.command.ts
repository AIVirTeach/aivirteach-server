import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({
  name: 'quota:grant',
  arguments: '<email> <minutes>',
  description: '给用户发放运行额度（分钟）',
})
export class QuotaGrantCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const minutes = Number.parseInt(inputs[1], 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new Error(`分钟数必须是正整数，收到：${inputs[1]}`);
    }

    const grant = await this.admin.grantQuota(inputs[0], minutes);
    console.log(`已为 ${inputs[0]} 发放 ${grant.minutesGranted} 分钟额度`);
  }
}
