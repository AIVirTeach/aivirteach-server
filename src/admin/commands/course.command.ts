import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface CourseCreateOptions {
  operator: string;
  reason: string;
  execute?: boolean;
  imageDigest?: string;
}

@Command({
  name: 'course:create',
  arguments: '<contentDir>',
  description: '从课程内容目录（含 course.json）摄取新建课程',
})
export class CourseCreateCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: CourseCreateOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [contentDir] = inputs;

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'course:create',
          dryRun: true,
          operator,
          reason,
          contentDir,
          imageDigest: options.imageDigest ?? null,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const course = await this.admin.createCourse(
      contentDir,
      operator,
      reason,
      options.imageDigest,
    );

    console.log(
      JSON.stringify({
        command: 'course:create',
        dryRun: false,
        operator,
        reason,
        slug: course.slug,
        title: course.title,
        version: course.versions[0]?.version,
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

  @Option({
    flags: '-i, --image-digest <imageDigest>',
    description: 'VM 镜像摘要，Labs 集成前可以不填',
  })
  parseImageDigest(val: string): string {
    return val;
  }
}

interface CoursePublishOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'course:publish',
  arguments: '<slug>',
  description: '发布课程的最新版本',
})
export class CoursePublishCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: CoursePublishOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const slug = inputs[0];

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'course:publish',
          dryRun: true,
          operator,
          reason,
          slug,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const version = await this.admin.publishCourse(slug, operator, reason);

    console.log(
      JSON.stringify({
        command: 'course:publish',
        dryRun: false,
        operator,
        reason,
        slug,
        version: version.version,
        publishedAt: version.publishedAt?.toISOString(),
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
