import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CoursesService } from './courses.service';

const buildPrisma = () => ({
  course: { findMany: jest.fn(), findUnique: jest.fn() },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [CoursesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(CoursesService);
};

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

    await expect(service.getDetail('missing')).rejects.toThrow(NotFoundException);
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
                  id: 'lesson_1',
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

    expect(detail.id).toBe('ai-daily-briefing');
    expect(detail.version).toBe(1);
    expect(detail.modules[0].lessons[0]).toEqual(
      expect.objectContaining({
        id: 'lesson_1',
        activity: { type: 'guided-lab', prompt: 'prompt', completionType: 'learner-confirmation' },
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

    await expect(service.getWelcome('ai-daily-briefing')).rejects.toThrow(NotFoundException);
  });
});
