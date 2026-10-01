import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseDraftService } from './course-draft.service';
import { CourseMetaPatchSchema, WelcomePatchSchema } from './draft.schemas';

describe('draft schemas', () => {
  it('accepts partial known course metadata and rejects unknown fields/levels', () => {
    expect(CourseMetaPatchSchema.parse({ title: 'New title' })).toEqual({
      title: 'New title',
    });
    expect(() => CourseMetaPatchSchema.parse({ extra: true })).toThrow();
    expect(() => CourseMetaPatchSchema.parse({ level: 'Expert' })).toThrow();
  });

  it('rejects unknown welcome fields', () => {
    expect(() => WelcomePatchSchema.parse({ extra: true })).toThrow();
  });
});

describe('CourseDraftService', () => {
  const published = {
    id: 'version-2',
    version: 2,
    imageDigest: 'sha256:abc',
    sourceFormat: 'markdown',
    sourcePath: 'course.md',
    sourceEncoding: 'utf8',
    sourceMarkdown: '# source',
    introFeaturedAssetIds: ['asset-1'],
    modules: [
      {
        position: 1,
        title: 'Module',
        description: 'Description',
        estimatedMinutes: 10,
        lessons: [
          {
            contentId: 'lesson-1',
            position: 1,
            title: 'Lesson',
            estimatedMinutes: 5,
            objectives: ['objective'],
            sourceRange: { startLine: 1, endLine: 2 },
            body: 'lesson body',
            content: { legacy: true },
            activityType: 'guided',
            activityPrompt: 'Do it',
            activityCompletionType: 'manual',
            assessmentIds: ['assessment-1'],
            assessments: [
              {
                type: 'quiz',
                question: 'Question?',
                options: ['A', 'B'],
                clientCriteria: ['A'],
                expectedResult: 'A',
                successCriteria: ['correct'],
                commonFailures: ['wrong'],
              },
            ],
          },
          {
            contentId: 'lesson-legacy-null',
            position: 2,
            title: 'Legacy lesson',
            estimatedMinutes: 1,
            objectives: [],
            sourceRange: null,
            body: '',
            content: null,
            activityType: 'guided',
            activityPrompt: 'Do it',
            activityCompletionType: 'manual',
            assessmentIds: [],
            assessments: [],
          },
        ],
      },
    ],
    welcome: {
      overviewAssetId: 'asset-1',
      overviewHeading: 'Welcome',
      overviewParagraphs: ['Hello'],
      howItWorksSteps: null,
      finalOutcome: 'Outcome',
    },
  };

  function setup() {
    const prisma = {
      course: { findUnique: jest.fn(), update: jest.fn() },
      courseVersion: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
      },
      courseWelcome: { upsert: jest.fn() },
      courseAsset: { create: jest.fn() },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
        callback(prisma),
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return {
      prisma,
      audit,
      service: new CourseDraftService(
        prisma as unknown as PrismaService,
        audit as unknown as AuditService,
      ),
    };
  }

  it('clones nullable JSON as SQL NULL and records create audit', async () => {
    const { prisma, audit, service } = setup();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1', slug: 'demo' });
    prisma.courseVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(published);
    prisma.courseVersion.create.mockResolvedValue({ id: 'draft-3' });

    await expect(service.createDraft('demo', 'operator')).resolves.toEqual({
      draft: { id: 'draft-3' },
      created: true,
    });
    const createArg = prisma.courseVersion.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      courseId: 'course-1',
      version: 3,
      imageDigest: 'sha256:abc',
      sourceFormat: 'markdown',
      sourcePath: 'course.md',
      sourceEncoding: 'utf8',
      introFeaturedAssetIds: ['asset-1'],
      modules: {
        create: [
          {
            lessons: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  contentId: 'lesson-1',
                  body: 'lesson body',
                  assessmentIds: ['assessment-1'],
                  assessments: {
                    create: [expect.objectContaining({ question: 'Question?' })],
                  },
                }),
              ]),
            },
          },
        ],
      },
      welcome: { create: expect.objectContaining({ overviewHeading: 'Welcome' }) },
    });
    const clonedLessons = createArg.data.modules.create[0].lessons.create;
    expect(clonedLessons[0].content).toEqual({ legacy: true });
    expect(clonedLessons[1].content).toBe(Prisma.DbNull);
    expect(createArg.data.welcome.create.howItWorksSteps).toBe(Prisma.DbNull);
    expect(createArg.data).not.toHaveProperty('sourceMarkdown');
    expect(createArg.data).not.toHaveProperty('meta');
    expect(createArg.data).not.toHaveProperty('publishedAt');
    expect(prisma.courseAsset.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.draft.create',
        actor: { type: 'OPERATOR', id: 'operator' },
        targetType: 'CourseVersion',
        targetId: 'draft-3',
        metadata: { slug: 'demo' },
      }),
      expect.anything(),
    );
  });

  it('returns an existing draft without creating a duplicate', async () => {
    const { prisma, service } = setup();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1', slug: 'demo' });
    prisma.courseVersion.findFirst.mockResolvedValue({ id: 'draft' });
    await expect(service.createDraft('demo', 'operator')).resolves.toEqual({
      draft: { id: 'draft' },
      created: false,
    });
    expect(prisma.courseVersion.create).not.toHaveBeenCalled();
  });

  it('recovers a concurrent draft creation after P2002', async () => {
    const { prisma, service } = setup();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1', slug: 'demo' });
    prisma.courseVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(published)
      .mockResolvedValueOnce({ id: 'winner-draft' });
    prisma.courseVersion.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.createDraft('demo', 'operator')).resolves.toEqual({
      draft: { id: 'winner-draft' },
      created: false,
    });
  });

  it('requires a published version and reports a missing course', async () => {
    const { prisma, service } = setup();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1' });
    prisma.courseVersion.findFirst.mockResolvedValue(null);
    await expect(service.createDraft('demo', 'operator')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    prisma.course.findUnique.mockResolvedValue(null);
    await expect(service.createDraft('missing', 'operator')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('requires an existing draft and records discard audit', async () => {
    const { prisma, audit, service } = setup();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1', slug: 'demo' });
    prisma.courseVersion.findFirst.mockResolvedValueOnce({ id: 'draft' });
    prisma.courseVersion.delete.mockResolvedValue({});
    await service.discardDraft('demo', 'operator');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.draft.discard', targetId: 'draft' }),
      expect.anything(),
    );

    prisma.courseVersion.findFirst.mockResolvedValueOnce(null);
    await expect(service.discardDraft('demo', 'operator')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('merges metadata on the draft and maps the level without touching Course', async () => {
    const { prisma, audit, service } = setup();
    const draft = { id: 'draft', meta: { title: 'Old', tags: ['one'] } };
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1', slug: 'demo' });
    prisma.courseVersion.findFirst
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({
        ...draft,
        meta: { title: 'New', tags: ['one'], level: 'INTERMEDIATE' },
      });
    prisma.courseVersion.update
      .mockResolvedValueOnce({
        ...draft,
        meta: { title: 'New', tags: ['one'], level: 'INTERMEDIATE' },
      })
      .mockResolvedValueOnce({
        ...draft,
        meta: {
          title: 'New',
          tags: ['one'],
          level: 'INTERMEDIATE',
          description: 'Added',
        },
      });
    await service.updateCourse('demo', { title: 'New', level: 'Intermediate' }, 'operator');
    await service.updateCourse('demo', { description: 'Added' }, 'operator');
    expect(prisma.courseVersion.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'draft' },
      data: { meta: { title: 'New', tags: ['one'], level: 'INTERMEDIATE' } },
      include: expect.any(Object),
    });
    expect(prisma.courseVersion.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'draft' },
      data: {
        meta: {
          title: 'New',
          tags: ['one'],
          level: 'INTERMEDIATE',
          description: 'Added',
        },
      },
      include: expect.any(Object),
    });
    expect(prisma.course.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.draft.updateCourse', targetId: 'draft' }),
      expect.anything(),
    );
  });

  it('upserts welcome data for a draft and records audit', async () => {
    const { prisma, audit, service } = setup();
    prisma.course.findUnique.mockResolvedValue({ id: 'course-1', slug: 'demo' });
    prisma.courseVersion.findFirst.mockResolvedValue({ id: 'draft' });
    prisma.courseWelcome.upsert.mockResolvedValue({ overviewHeading: 'Edited' });
    prisma.courseVersion.findUnique.mockResolvedValue({ id: 'draft', welcome: { overviewHeading: 'Edited' } });
    await service.updateWelcome('demo', { overviewHeading: 'Edited' }, 'operator');
    expect(prisma.courseWelcome.upsert).toHaveBeenCalledWith({
      where: { courseVersionId: 'draft' },
      create: { courseVersionId: 'draft', overviewHeading: 'Edited' },
      update: { overviewHeading: 'Edited' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.draft.updateWelcome', targetId: 'draft' }),
      expect.anything(),
    );
  });
});
