import { Test } from '@nestjs/testing';
import { AdminService } from '../admin.service';
import {
  CourseCreateCommand,
  CoursePublishCommand,
  CourseSetCoverCommand,
} from './course.command';

const OPERATOR = 'ops@example.com';
const REASON = '开课准备';

const buildCommand = async <
  T extends CourseCreateCommand | CoursePublishCommand | CourseSetCoverCommand,
>(
  CommandClass: new (...args: never[]) => T,
  admin: Partial<AdminService> = {},
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [CommandClass, { provide: AdminService, useValue: admin }],
  }).compile();
  return moduleRef.get(CommandClass);
};

describe('CourseCreateCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService', async () => {
    const createCourse = jest.fn();
    const command = await buildCommand(CourseCreateCommand, { createCourse });

    await command.run(['/content/n8n'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(createCourse).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:create',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        contentDir: '/content/n8n',
        imageDigest: null,
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService 并透传 imageDigest', async () => {
    const createCourse = jest.fn().mockResolvedValue({
      slug: 'n8n',
      title: 'n8n 自动化工作流',
      versions: [{ version: 1 }],
    });
    const command = await buildCommand(CourseCreateCommand, { createCourse });

    await command.run(['/content/n8n'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
      imageDigest: 'sha256:abc',
    });

    expect(createCourse).toHaveBeenCalledWith(
      '/content/n8n',
      OPERATOR,
      REASON,
      'sha256:abc',
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:create',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        slug: 'n8n',
        title: 'n8n 自动化工作流',
        version: 1,
      }),
    );
  });

  it('reason 为空时拒绝，不调用 AdminService', async () => {
    const createCourse = jest.fn();
    const command = await buildCommand(CourseCreateCommand, { createCourse });

    await expect(
      command.run(['/content/n8n'], {
        operator: OPERATOR,
        reason: '',
      }),
    ).rejects.toThrow('reason 不能为空');
    expect(createCourse).not.toHaveBeenCalled();
  });
});

describe('CoursePublishCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService', async () => {
    const publishCourse = jest.fn();
    const command = await buildCommand(CoursePublishCommand, {
      publishCourse,
    });

    await command.run(['n8n'], { operator: OPERATOR, reason: REASON });

    expect(publishCourse).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:publish',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        slug: 'n8n',
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService 并打印发布时间', async () => {
    const publishedAt = new Date('2026-08-19T00:00:00.000Z');
    const publishCourse = jest
      .fn()
      .mockResolvedValue({ version: 1, publishedAt });
    const command = await buildCommand(CoursePublishCommand, {
      publishCourse,
    });

    await command.run(['n8n'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(publishCourse).toHaveBeenCalledWith('n8n', OPERATOR, REASON);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:publish',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        slug: 'n8n',
        version: 1,
        publishedAt: publishedAt.toISOString(),
      }),
    );
  });

  it('operator 不是合法邮箱时拒绝', async () => {
    const publishCourse = jest.fn();
    const command = await buildCommand(CoursePublishCommand, {
      publishCourse,
    });

    await expect(
      command.run(['n8n'], { operator: 'nope', reason: REASON }),
    ).rejects.toThrow('operator 必须是合法邮箱');
    expect(publishCourse).not.toHaveBeenCalled();
  });
});

describe('CourseSetCoverCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService', async () => {
    const setCourseCover = jest.fn();
    const command = await buildCommand(CourseSetCoverCommand, {
      setCourseCover,
    });

    await command.run(['n8n', '/tmp/cover.png'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(setCourseCover).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:set-cover',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        slug: 'n8n',
        filePath: '/tmp/cover.png',
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService 并打印结果', async () => {
    const setCourseCover = jest.fn().mockResolvedValue({
      id: 'asset_1',
      objectKey: 'https://blob.vercel-storage.com/courses/n8n/cover.png',
    });
    const command = await buildCommand(CourseSetCoverCommand, {
      setCourseCover,
    });

    await command.run(['n8n', '/tmp/cover.png'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
    });

    expect(setCourseCover).toHaveBeenCalledWith(
      'n8n',
      '/tmp/cover.png',
      OPERATOR,
      REASON,
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:set-cover',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        slug: 'n8n',
        assetId: 'asset_1',
        objectKey: 'https://blob.vercel-storage.com/courses/n8n/cover.png',
      }),
    );
  });

  it('reason 为空时拒绝，不调用 AdminService', async () => {
    const setCourseCover = jest.fn();
    const command = await buildCommand(CourseSetCoverCommand, {
      setCourseCover,
    });

    await expect(
      command.run(['n8n', '/tmp/cover.png'], {
        operator: OPERATOR,
        reason: '',
      }),
    ).rejects.toThrow('reason 不能为空');
    expect(setCourseCover).not.toHaveBeenCalled();
  });
});
