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
    expect(ReorderSchema.safeParse({ modules: [], extra: true }).success).toBe(
      false,
    );
  });
});

describe('DraftContentService', () => {
  function setup(
    draft: any = {
      id: 'draft',
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
      course: {
        findUnique: jest.fn().mockResolvedValue({ id: 'c', slug: 'demo' }),
      },
      courseVersion: {
        findFirst: jest.fn().mockResolvedValue(draft),
        findUnique: jest.fn().mockResolvedValue(draft),
      },
      courseModule: {
        findFirst: jest.fn().mockResolvedValue({ position: 2 }),
        create: jest.fn().mockResolvedValue({ id: 'm3' }),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      courseLesson: {
        findMany: jest.fn(),
        findFirst: jest
          .fn()
          .mockImplementation((args: any) =>
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
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
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

  it('appends modules and lessons, defaults body, and audits writes', async () => {
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
    await service.createLesson(
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
          body: '',
          position: 2,
          activityType: 'lab',
          activityPrompt: 'Do',
          activityCompletionType: 'manual',
        }),
      }),
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
    prisma.courseModule.delete.mockResolvedValue({});
    prisma.courseModule.updateMany.mockResolvedValue({ count: 1 });
    await service.deleteModule('demo', 'm1', 'op');
    expect(prisma.courseModule.updateMany).toHaveBeenCalled();
    prisma.courseLesson.findFirst.mockResolvedValue({
      id: 'l1',
      moduleId: 'm1',
      position: 1,
    });
    prisma.courseLesson.delete.mockResolvedValue({});
    prisma.courseLesson.updateMany.mockResolvedValue({ count: 0 });
    await service.deleteLesson('demo', 'one', 'op');
    expect(prisma.courseLesson.updateMany).toHaveBeenCalled();
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
});
