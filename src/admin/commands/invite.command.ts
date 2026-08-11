import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({
  name: 'invite',
  arguments: '<email>',
  description: '邀请一个封测用户',
})
export class InviteCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const result = await this.admin.inviteUser(inputs[0]);

    console.log(`已邀请 ${result.email}`);
    console.log(`邀请码（只显示这一次）：${result.invitationToken}`);
    console.log(`有效期至：${result.expiresAt.toISOString()}`);
  }
}
