import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({
  name: 'enroll',
  arguments: '<email> <courseSlug>',
  description: '给用户开课',
})
export class EnrollCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    await this.admin.enrollUser(inputs[0], inputs[1]);
    console.log(`已为 ${inputs[0]} 开通课程 ${inputs[1]}`);
  }
}
