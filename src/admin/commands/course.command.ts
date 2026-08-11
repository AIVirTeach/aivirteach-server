import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({
  name: 'course:create',
  arguments: '<slug> <title>',
  description: '新建课程',
})
export class CourseCreateCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const course = await this.admin.createCourse(inputs[0], inputs[1]);
    console.log(`已创建课程 ${course.slug}（${course.title}），尚未发布`);
  }
}

@Command({
  name: 'course:publish',
  arguments: '<slug>',
  description: '发布课程',
})
export class CoursePublishCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const course = await this.admin.publishCourse(inputs[0]);
    console.log(`已发布课程 ${course.slug}`);
  }
}
