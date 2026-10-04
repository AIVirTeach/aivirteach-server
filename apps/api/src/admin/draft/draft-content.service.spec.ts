import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseDraftService } from './course-draft.service';
import { DraftContentService } from './draft-content.service';
import {
  CreateLessonSchema,
  ReorderSchema,
  UpdateLessonPatchSchema,
} from './draft.schemas';

describe('draft content schemas', () => {
  it('accepts kebab case lesson ids and rejects contentId in patches', () => {
    expect(
      CreateLessonSchema.safeParse({
        contentId: 'lesson-one',
        title: 'L',
        estimatedMinutes: 1,
        activity: { type: 'guided', prompt: 'Go', completionType: 'manual' },
      }).success,
    ).toBe(true);
    expect(
      CreateLessonSchema.safeParse({
        contentId: 'Lesson One',
        title: 'L',
        estimatedMinutes: 1,
        activity: { type: 'guided', prompt: 'Go', completionType: 'manual' },
      }).success,
    ).toBe(false);
    expect(
      UpdateLessonPatchSchema.safeParse({ contentId: 'changed' }).success,
    ).toBe(false);
    expect(
      CreateLessonSchema.safeParse({
        contentId: 'lesson-one',
        title: 'L',
        body: 'legacy',
        estimatedMinutes: 1,
        activity: { type: 'guided', prompt: 'Go', completionType: 'manual' },
      }).success,
    ).toBe(false);
    expect(UpdateLessonPatchSchema.safeParse({ body: 'legacy' }).success).toBe(
      false,
    );
    expect(ReorderSchema.safeParse({ modules: [], extra: true }).success).toBe(
      false,
    );
  });
});

describe('DraftContentService', () => {
  function setup(
    draft: any = {
      id: 'draft',
      courseId: 'c',
      modules: [
        {
          id: 'm1',
          title: 'Module 1',
          position: 1,
          lessons: [
            {
              id: 'l1',
              contentId: 'one',
              position: 1,
              assessments: [{ id: 'a1' }],
            },
          ],
        },
        {
          id: 'm2',
          title: 'Module 2',
          position: 2,
          lessons: [
            { id: 'l2', contentId: 'two', position: 1, assessments: [] },
          ],
        },
      ],
    },
  ) {
    const prisma: any = {
      courseAsset: {
        findMany: jest.fn().mockResolvedValue([{ id: 'asset-local' }]),
      },
      course: {
        findUnique: jest.fn().mockResolvedValue({ id: 'c', slug: 'demo' }),
      },
      courseVersion: {
        findFirst: jest.fn().mockResolvedValue(draft),
        findUnique: jest.fn().mockResolvedValue(draft),
      },
      courseModule: {
        findFirst: jest.fn().mockResolvedValue({ position: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'm3' }),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      courseLesson: {
        // 带 contentId 的是按 contentId 找课时行；不带的是删除后读兄弟序号（各用例自行 mock）。
        findMany: jest
          .fn()
          .mockImplementation((args: { where: { contentId?: string } }) => {
            const modules = (draft.modules ?? []) as {
              id: string;
              title: string;
              lessons: { id: string; contentId: string; position: number }[];
            }[];
            return Promise.resolve(
              args.where.contentId === undefined
                ? []
                : modules.flatMap((module) =>
                    module.lessons
                      .filter(
                        (lesson) => lesson.contentId === args.where.contentId,
                      )
                      .map((lesson) => ({
                        id: lesson.id,
                        moduleId: module.id,
                        position: lesson.position,
                        module: { title: module.title },
                      })),
                  ),
            );
          }),
        findFirst: jest
          .fn()
          .mockImplementation((args: { where: { contentId?: string } }) =>
            Promise.resolve(args.where.contentId ? null : { position: 1 }),
          ),
        create: jest.fn().mockResolvedValue({ id: 'l3' }),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      lessonAssessment: {
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'draft' }]),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
    const drafts = new CourseDraftService(
      prisma as PrismaService,
      audit as AuditService,
    );
    return {
      prisma,
      audit,
      service: new DraftContentService(prisma, drafts, audit),
      draft,
    };
  }

  it('refuses draft writes once the version is no longer an unpublished draft', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(
      service.createModule(
        'demo',
        { title: 'New', description: 'D', estimatedMinutes: 4 },
        'op',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.courseModule.create).not.toHaveBeenCalled();
  });

  it('rejects a lesson contentId that already exists in another module of the draft', async () => {
    const { prisma, service } = setup();
    prisma.courseLesson.findFirst.mockImplementation(
      (args: { where: { contentId?: string; module?: unknown } }) =>
        Promise.resolve(
          args.where.contentId
            ? args.where.module
              ? { id: 'other-module-lesson' }
              : null
            : { position: 1 },
        ),
    );
    await expect(
      service.createLesson(
        'demo',
        'm1',
        {
          contentId: 'two',
          title: 'L',
          estimatedMinutes: 1,
          activity: { type: 'guided', prompt: 'Go', completionType: 'manual' },
        },
        'op',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.courseLesson.create).not.toHaveBeenCalled();
  });

  it('appends modules and lessons, defaults empty content, and audits writes', async () => {
    const { prisma, audit, service } = setup();
    prisma.courseModule.create.mockResolvedValue({ id: 'm3' });
    await service.createModule(
      'demo',
      { title: 'New', description: 'D', estimatedMinutes: 4 },
      'op',
    );
    expect(prisma.courseModule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          courseVersionId: 'draft',
          position: 3,
        }),
      }),
    );
    prisma.courseModule.findFirst.mockResolvedValue({ id: 'm1', position: 1 });
    const result = await service.createLesson(
      'demo',
      'm1',
      {
        contentId: 'three',
        title: 'New lesson',
        estimatedMinutes: 2,
        activity: { type: 'lab', prompt: 'Do', completionType: 'manual' },
      },
      'op',
    );
    expect(prisma.courseLesson.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: { schemaVersion: 1, blocks: [] },
          position: 2,
          activityType: 'lab',
          activityPrompt: 'Do',
          activityCompletionType: 'manual',
        }),
      }),
    );
    expect(result.problems.errors).toEqual([]);
    expect(result.problems.warnings.map(({ code }) => code)).toContain(
      'no-blocks',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.draft.createModule' }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.draft.createLesson' }),
      prisma,
    );
  });

  it('saves invalid block content and returns validation problems, then clears them after repair', async () => {
    const { service, prisma } = setup();
    const content = {
      schemaVersion: 1,
      blocks: [
        { id: 'bad', type: 'future-block', props: {} },
        {
          id: 'img',
          type: 'image',
          props: { assetId: 'asset-local', alt: '' },
        },
      ],
    };
    prisma.courseLesson.update.mockResolvedValue({});
    const saved = await service.updateLesson('demo', 'one', { content }, 'op');
    expect(prisma.courseLesson.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { content } }),
    );
    expect(saved.problems.errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['unknown-type', 'invalid-props']),
    );
    const repaired = await service.updateLesson(
      'demo',
      'one',
      {
        content: {
          schemaVersion: 1,
          blocks: [
            {
              id: 'img',
              type: 'image',
              props: { assetId: 'asset-local', alt: 'A view' },
            },
          ],
        },
      },
      'op',
    );
    expect(repaired.problems.errors).toEqual([]);
    expect(repaired.problems.warnings).toEqual([]);
    expect(prisma.courseAsset.findMany).toHaveBeenCalledWith({
      where: { courseId: 'c' },
      select: { id: true },
    });
  });

  it.each([
    ['text', 'invalid'],
    ['null', null],
    ['array', []],
  ] as const)(
    'rejects a %s lesson envelope without writes',
    async (_label, content) => {
      const { service, prisma } = setup();
      await expect(
        service.updateLesson('demo', 'one', { content }, 'op'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.courseLesson.update).not.toHaveBeenCalled();
    },
  );

  it('rejects content over 256 KB without writes', async () => {
    const { service, prisma } = setup();
    const content = {
      schemaVersion: 1,
      blocks: [],
      extra: 'x'.repeat(256 * 1024),
    };
    await expect(
      service.updateLesson('demo', 'one', { content }, 'op'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports image asset IDs outside the course while accepting local asset IDs', async () => {
    const { service, prisma } = setup();
    prisma.courseAsset.findMany.mockResolvedValue([{ id: 'asset-local' }]);
    const result = await service.updateLesson(
      'demo',
      'one',
      {
        content: {
          schemaVersion: 1,
          blocks: [
            {
              id: 'local',
              type: 'image',
              props: { assetId: 'asset-local', alt: 'Local' },
            },
            {
              id: 'foreign',
              type: 'image',
              props: { assetId: 'asset-other', alt: 'Other' },
            },
          ],
        },
      },
      'op',
    );
    expect(result.problems.errors.map(({ code }) => code)).toContain(
      'unknown-asset',
    );
    expect(
      result.problems.errors.filter(({ code }) => code === 'unknown-asset'),
    ).toHaveLength(1);
  });

  it('rejects ambiguous contentId before writes and reports module titles', async () => {
    const dup = {
      id: 'draft',
      modules: [
        {
          id: 'm1',
          title: 'Alpha',
          lessons: [{ id: 'l1', contentId: 'same' }],
        },
        { id: 'm2', title: 'Beta', lessons: [{ id: 'l2', contentId: 'same' }] },
      ],
    };
    const { service, prisma } = setup(dup);
    await expect(
      service.updateLesson('demo', 'same', { title: 'x' }, 'op'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.courseLesson.update).not.toHaveBeenCalled();
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();
  });

  it('rejects ambiguous deleteLesson without writing', async () => {
    const dup = {
      id: 'draft',
      modules: [
        {
          id: 'm1',
          title: 'Alpha',
          lessons: [{ id: 'l1', contentId: 'same' }],
        },
        { id: 'm2', title: 'Beta', lessons: [{ id: 'l2', contentId: 'same' }] },
      ],
    };
    const { service, prisma } = setup(dup);
    await expect(
      service.deleteLesson('demo', 'same', 'op'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.courseLesson.delete).not.toHaveBeenCalled();
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();
  });

  it('requires exact reorder permutations and performs collision-safe positional shifts', async () => {
    const { service, prisma } = setup();
    await expect(
      service.reorder(
        'demo',
        { modules: [{ id: 'm1', lessons: ['one'] }] },
        'op',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.courseModule.updateMany).not.toHaveBeenCalled();
    prisma.courseModule.updateMany.mockResolvedValue({ count: 2 });
    prisma.courseLesson.updateMany.mockResolvedValue({ count: 2 });
    await service.reorder(
      'demo',
      {
        modules: [
          { id: 'm2', lessons: ['one', 'two'] },
          { id: 'm1', lessons: [] },
        ],
      },
      'op',
    );
    expect(prisma.courseModule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ position: expect.any(Object) }),
      }),
    );
    expect(prisma.courseLesson.updateMany).toHaveBeenCalled();
  });

  it('renumbers after deletes, updates assessment and throws when draft is missing', async () => {
    const { service, prisma } = setup();
    prisma.courseModule.findFirst.mockResolvedValue({ id: 'm1', position: 1 });
    prisma.courseModule.findMany.mockResolvedValue([{ id: 'm2', position: 2 }]);
    prisma.courseModule.delete.mockResolvedValue({});
    prisma.courseModule.updateMany.mockResolvedValue({ count: 1 });
    await service.deleteModule('demo', 'm1', 'op');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.courseModule.updateMany).toHaveBeenCalledWith({
      where: { courseVersionId: 'draft', position: { gt: 1 } },
      data: { position: { increment: 1_000_000 } },
    });
    expect(prisma.courseModule.update).toHaveBeenCalledWith({
      where: { id: 'm2' },
      data: { position: 1 },
    });
    expect(
      prisma.courseModule.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.courseModule.update.mock.invocationCallOrder[0]);
    expect(prisma.courseModule.delete.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.courseModule.updateMany.mock.invocationCallOrder[0],
    );

    const lessonDraft = {
      id: 'draft',
      modules: [
        {
          id: 'm1',
          title: 'Module 1',
          position: 1,
          lessons: [
            { id: 'l1', contentId: 'one', position: 1, assessments: [] },
            { id: 'l1b', contentId: 'one-b', position: 2, assessments: [] },
          ],
        },
        { id: 'm2', title: 'Module 2', position: 2, lessons: [] },
      ],
    };
    const lessonSetup = setup(lessonDraft);
    lessonSetup.prisma.courseLesson.findMany.mockImplementation(
      (args: { where: { contentId?: string } }) =>
        Promise.resolve(
          args.where.contentId
            ? [
                {
                  id: 'l1',
                  moduleId: 'm1',
                  position: 1,
                  module: { title: 'Module 1' },
                },
              ]
            : [{ id: 'l1b', position: 2 }],
        ),
    );
    lessonSetup.prisma.courseLesson.delete.mockResolvedValue({});
    lessonSetup.prisma.courseLesson.updateMany.mockResolvedValue({ count: 1 });
    await lessonSetup.service.deleteLesson('demo', 'one', 'op');
    expect(lessonSetup.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(lessonSetup.prisma.courseLesson.updateMany).toHaveBeenCalledWith({
      where: { moduleId: 'm1', position: { gt: 1 } },
      data: { position: { increment: 1_000_000 } },
    });
    expect(lessonSetup.prisma.courseLesson.update).toHaveBeenCalledWith({
      where: { id: 'l1b' },
      data: { position: 1 },
    });
    expect(
      lessonSetup.prisma.courseLesson.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      lessonSetup.prisma.courseLesson.update.mock.invocationCallOrder[0],
    );
    expect(
      lessonSetup.prisma.courseLesson.delete.mock.invocationCallOrder[0],
    ).toBeLessThan(
      lessonSetup.prisma.courseLesson.updateMany.mock.invocationCallOrder[0],
    );

    prisma.lessonAssessment.updateMany.mockResolvedValue({ count: 1 });
    await service.updateAssessment(
      'demo',
      'a1',
      { question: 'Updated?' },
      'op',
    );
    expect(prisma.lessonAssessment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a1', lesson: { module: { courseVersionId: 'draft' } } },
        data: { question: 'Updated?' },
      }),
    );
    prisma.courseVersion.findFirst.mockResolvedValue(null);
    await expect(
      service.deleteModule('demo', 'm1', 'op'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('locks the draft before reading siblings, so renumbering uses live rows', async () => {
    const { service, prisma } = setup();
    prisma.courseModule.findFirst.mockResolvedValue({ id: 'm1', position: 1 });
    // 锁之后才出现的新模块（position 3）也必须被重新编号。
    prisma.courseModule.findMany.mockResolvedValue([
      { id: 'm2', position: 2 },
      { id: 'm-new', position: 3 },
    ]);
    await service.deleteModule('demo', 'm1', 'op');
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.courseModule.findMany.mock.invocationCallOrder[0],
    );
    expect(prisma.courseModule.update).toHaveBeenCalledWith({
      where: { id: 'm-new' },
      data: { position: 2 },
    });
  });

  it('validates reorder against the snapshot read after the lock', async () => {
    const { service, prisma, draft } = setup();
    // 锁之后的快照里多了一个并发创建的模块：只含旧两个模块的排列必须被拒。
    prisma.courseVersion.findUnique.mockResolvedValue({
      ...draft,
      modules: [
        ...draft.modules,
        { id: 'm3', title: 'Module 3', position: 3, lessons: [] },
      ],
    });
    await expect(
      service.reorder(
        'demo',
        {
          modules: [
            { id: 'm2', lessons: ['two'] },
            { id: 'm1', lessons: ['one'] },
          ],
        },
        'op',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.courseModule.update).not.toHaveBeenCalled();
  });

  it('answers writes with a summary that omits lesson body and content', async () => {
    const { service, prisma } = setup();
    await service.createModule(
      'demo',
      { title: 'M', description: '', estimatedMinutes: 1 },
      'op',
    );
    const arg = prisma.courseVersion.findUnique.mock.calls.at(-1)[0];
    expect(arg.include.modules.include.lessons.omit).toEqual({
      body: true,
      content: true,
    });
  });
});
