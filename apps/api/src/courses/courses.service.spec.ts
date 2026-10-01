import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CoursesService } from './courses.service';
import { LATEST_PUBLISHED_VERSION } from './published-version';

const buildPrisma = () => ({
  course: { findMany: jest.fn(), findUnique: jest.fn() },
  courseAsset: { findUnique: jest.fn(), findMany: jest.fn() },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [CoursesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(CoursesService);
};

describe('LATEST_PUBLISHED_VERSION', () => {
  it('filters drafts and selects the highest published version', () => {
    expect(LATEST_PUBLISHED_VERSION).toMatchObject({
      where: { publishedAt: { not: null } },
      orderBy: { version: 'desc' },
      take: 1,
    });
  });
});

describe('CoursesService.listPublished', () => {
  it('只列已发布课程，id 字段用 slug 而不是内部 cuid', async () => {
    const prisma = buildPrisma();
    prisma.course.findMany.mockResolvedValue([
      {
        id: 'course_cuid_1',
        slug: 'ai-daily-briefing',
        title: 'Build an AI Daily Briefing',
        category: 'AI Automation',
        description: 'desc',
        level: 'INTERMEDIATE',
        durationMinutes: 480,
        lessonCount: 11,
        published: true,
        coverAssetId: null,
      },
    ]);
    const service = await buildService(prisma);

    const result = await service.listPublished();

    expect(prisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'ai-daily-briefing',
        level: 'Intermediate',
      }),
    ]);
  });
});

describe('CoursesService.getDetail', () => {
  it('课程不存在时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.getDetail('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('课程没有已发布版本时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'draft-only',
      published: true,
      versions: [],
    });
    const service = await buildService(prisma);

    await expect(service.getDetail('draft-only')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('返回完整 detail，modules/lessons 按 position 排序拼好', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'ai-daily-briefing',
      contentId: 'n8n-agent-builder',
      title: 'Build an AI Daily Briefing',
      shortTitle: 'AI Daily Briefing',
      category: 'AI Automation',
      description: 'desc',
      level: 'INTERMEDIATE',
      language: 'en',
      durationMinutes: 480,
      lessonCount: 11,
      tags: ['n8n'],
      outcomes: ['outcome 1'],
      requirements: ['req 1'],
      published: true,
      coverAssetId: null,
      versions: [
        {
          id: 'version_1',
          version: 1,
          modules: [
            {
              id: 'module_1',
              position: 1,
              title: 'Module One',
              description: 'desc',
              estimatedMinutes: 150,
              lessons: [
                {
                  id: 'lesson_cuid_1',
                  contentId: 'verify-virtual-machine',
                  position: 1,
                  title: 'Lesson One',
                  estimatedMinutes: 25,
                  objectives: ['obj'],
                  activityType: 'guided-lab',
                  activityPrompt: 'prompt',
                  activityCompletionType: 'learner-confirmation',
                },
              ],
            },
          ],
        },
      ],
    });
    const service = await buildService(prisma);

    const detail = await service.getDetail('ai-daily-briefing');

    expect(prisma.course.findUnique).toHaveBeenCalledWith({
      where: { slug: 'ai-daily-briefing' },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });

    expect(detail.id).toBe('ai-daily-briefing');
    expect(detail.version).toBe(1);
    expect(detail.modules[0].lessons[0]).toEqual(
      expect.objectContaining({
        id: 'verify-virtual-machine',
        activity: {
          type: 'guided-lab',
          prompt: 'prompt',
          completionType: 'learner-confirmation',
        },
      }),
    );
  });
});

describe('CoursesService.getWelcome', () => {
  it('welcome.json 还没摄取时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'ai-daily-briefing',
      published: true,
      versions: [{ id: 'version_1', welcome: null }],
    });
    const service = await buildService(prisma);

    await expect(service.getWelcome('ai-daily-briefing')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.course.findUnique).toHaveBeenCalledWith({
      where: { slug: 'ai-daily-briefing' },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });
  });
});

describe('CoursesService.getLesson', () => {
  const versionWithTwoLessons = {
    id: 'version_1',
    version: 1,
    sourceMarkdown: 'irrelevant legacy source',
    modules: [
      {
        id: 'module_1',
        position: 1,
        title: 'Module One',
        lessons: [
          {
            id: 'lesson_cuid_1',
            contentId: 'verify-virtual-machine',
            position: 1,
            title: 'Lesson One',
            estimatedMinutes: 15,
            objectives: ['a'],
            sourceRange: { startLine: 1, endLine: 2 },
            body: 'body from lesson one',
            content: null as Prisma.JsonValue,
            activityType: 'guided-lab',
            activityPrompt: 'p',
            activityCompletionType: 'learner-confirmation',
          },
          {
            id: 'lesson_cuid_2',
            contentId: 'verify-network',
            position: 2,
            title: 'Lesson Two',
            estimatedMinutes: 15,
            objectives: ['b'],
            sourceRange: { startLine: 3, endLine: 4 },
            body: 'body from lesson two',
            content: null as Prisma.JsonValue,
            activityType: 'guided-lab',
            activityPrompt: 'p',
            activityCompletionType: 'learner-confirmation',
          },
        ],
      },
    ],
  };

  it('从 lesson body 读取正文并计算 navigation', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      published: true,
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    const lesson = await service.getLesson('sample', 'verify-virtual-machine');

    expect(lesson.markdown).toBe('body from lesson one');
    expect(prisma.course.findUnique).toHaveBeenCalledWith({
      where: { slug: 'sample' },
      include: { versions: LATEST_PUBLISHED_VERSION },
    });
    expect(lesson.lesson.id).toBe('verify-virtual-machine');
    expect(lesson.module).toEqual({
      id: 'module_1',
      title: 'Module One',
      position: 1,
    });
    expect(lesson.navigation).toEqual({
      previousLessonId: null,
      nextLessonId: 'verify-network',
      index: 0,
      total: 2,
    });
    expect(lesson.assessment).toBeNull();
    expect(prisma.courseAsset.findMany).not.toHaveBeenCalled();
  });

  it('只按本课程和图片块引用的 id 查询素材', async () => {
    const prisma = buildPrisma();
    const version = structuredClone(versionWithTwoLessons);
    version.modules[0].lessons[0].content = {
      schemaVersion: 1,
      blocks: [{ id: 'image', type: 'image', props: { assetId: 'owned', alt: 'owned' } }],
    };
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1', slug: 'sample', published: true, versions: [version],
    });
    prisma.courseAsset.findMany.mockResolvedValue([
      { id: 'owned', objectKey: 'https://cdn.test/owned.png', altText: null },
    ]);
    const service = await buildService(prisma);

    const lesson = await service.getLesson('sample', 'verify-virtual-machine');

    expect(prisma.courseAsset.findMany).toHaveBeenCalledWith({
      where: { courseId: 'course_cuid_1', id: { in: ['owned'] } },
    });
    expect(lesson.assets).toEqual({ owned: { url: 'https://cdn.test/owned.png' } });
  });

  it('第二课的 navigation 指回第一课，且没有 next', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      published: true,
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    const lesson = await service.getLesson('sample', 'verify-network');

    expect(lesson.markdown).toBe('body from lesson two');
    expect(lesson.navigation).toEqual({
      previousLessonId: 'verify-virtual-machine',
      nextLessonId: null,
      index: 1,
      total: 2,
    });
  });

  it('lessonId 不属于该课程时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      published: true,
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    await expect(service.getLesson('sample', 'nope')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('用内部 cuid（而不是 content id）查询时抛 NotFoundException——路由参数不能是内部 id', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      published: true,
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    await expect(service.getLesson('sample', 'lesson_cuid_1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CoursesService.getAssetUrl', () => {
  it('课程不存在时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.getAssetUrl('missing', 'asset_1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.courseAsset.findUnique).not.toHaveBeenCalled();
  });

  it('课程未发布时抛 NotFoundException，不暴露未发布课程的素材', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      published: false,
    });
    const service = await buildService(prisma);

    await expect(service.getAssetUrl('sample', 'asset_1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.courseAsset.findUnique).not.toHaveBeenCalled();
  });

  it('assetId 不存在时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      published: true,
    });
    prisma.courseAsset.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.getAssetUrl('sample', 'asset_1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('assetId 属于另一门课程时抛 NotFoundException——不能跨课程用别人的 assetId', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      published: true,
    });
    prisma.courseAsset.findUnique.mockResolvedValue({
      id: 'asset_1',
      courseId: 'course_OTHER',
      objectKey: 'https://blob.vercel-storage.com/courses/other/cover.png',
    });
    const service = await buildService(prisma);

    await expect(service.getAssetUrl('sample', 'asset_1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('返回 asset 的 objectKey（Blob 公开 URL）', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      published: true,
    });
    prisma.courseAsset.findUnique.mockResolvedValue({
      id: 'asset_1',
      courseId: 'course_1',
      objectKey: 'https://blob.vercel-storage.com/courses/sample/cover.png',
    });
    const service = await buildService(prisma);

    const url = await service.getAssetUrl('sample', 'asset_1');

    expect(url).toBe(
      'https://blob.vercel-storage.com/courses/sample/cover.png',
    );
  });
});
