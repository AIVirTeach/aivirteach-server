import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CourseDraftService } from './draft/course-draft.service';
import { CoursePublishService } from './course-publish.service';

const lesson = (contentId: string, position: number, minutes = 10) => ({
  id: `row-${contentId}`,
  contentId,
  position,
  title: `课时 ${contentId}`,
  body: 'lesson body',
  content: {
    schemaVersion: 1,
    blocks: [
      { id: `p-${contentId}`, type: 'paragraph', props: { text: 'body' } },
    ],
  },
  estimatedMinutes: minutes,
});
const makeDraft = (overrides: Record<string, unknown> = {}) => ({
  id: 'draft-2',
  version: 2,
  courseId: 'course-1',
  publishedAt: null,
  meta: { title: '新标题', level: 'Intermediate' },
  welcome: null,
  modules: [
    {
      id: 'module-1',
      position: 1,
      title: '模块一',
      lessons: [lesson('a', 1, 5), lesson('c', 2, 15)],
    },
  ],
  ...overrides,
});

function setup({
  published = false,
  hasPriorPublished = true,
  draft = makeDraft(),
} = {}) {
  const tx = {
    courseVersion: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ ...draft, publishedAt: new Date() }),
    },
    course: { update: jest.fn().mockResolvedValue({}) },
    progress: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  let transactionCommitted = false;
  const prisma = {
    course: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'course-1',
        slug: 'demo',
        published: published,
        coverAssetId: null,
      }),
    },
    courseVersion: {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where.publishedAt) {
          return Promise.resolve(
            hasPriorPublished
              ? {
                  modules: [
                    {
                      lessons: [lesson('a', 1), lesson('b', 2), lesson('c', 3)],
                    },
                  ],
                }
              : null,
          );
        }
        return Promise.resolve(
          published
            ? { id: 'draft-2', version: 2, publishedAt: new Date() }
            : { id: 'draft-2', version: 2, publishedAt: null },
        );
      }),
    },
    courseAsset: { findMany: jest.fn().mockResolvedValue([{ id: 'asset-1' }]) },
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        const result = await callback(tx);
        transactionCommitted = true;
        return result;
      },
    ),
  };
  const audit = {
    record: jest.fn(async () => {
      expect(transactionCommitted).toBe(true);
    }),
  };
  const drafts = { requireDraft: jest.fn().mockResolvedValue(draft) };
  const service = new CoursePublishService(
    prisma as unknown as PrismaService,
    drafts as unknown as CourseDraftService,
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, audit, drafts };
}

describe('CoursePublishService.publish', () => {
  it('sets Course.published true on successful first publish', async () => {
    const { service, tx } = setup({ hasPriorPublished: false });
    await service.publish('demo', 'ops@example.com', 'first release');
    expect(tx.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: true }),
      }),
    );
  });

  it('publishes atomically, recomputes course summary, remaps only active removed pointers, then audits', async () => {
    const { service, prisma, tx, audit } = setup();
    const result = await service.publish('demo', 'ops@example.com', 'release');

    expect(result.id).toBe('draft-2');
    expect(tx.courseVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft-2', publishedAt: null },
      data: { publishedAt: expect.any(Date) },
    });
    expect(tx.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'course-1' },
        data: expect.objectContaining({
          published: true,
          lessonCount: 2,
          durationMinutes: 20,
          title: '新标题',
          level: 'INTERMEDIATE',
        }),
      }),
    );
    expect(tx.progress.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.progress.updateMany).toHaveBeenCalledWith({
      where: {
        currentLessonContentId: 'b',
        enrollment: { is: { courseId: 'course-1' } },
      },
      data: { currentLessonContentId: 'c' },
    });
    // Null and completed progress pointers are outside the exact removed-id predicate.
    expect(audit.record).toHaveBeenCalledWith({
      actor: { type: AuditActorType.OPERATOR, id: 'ops@example.com' },
      action: 'admin.publishCourse',
      success: true,
      targetType: 'CourseVersion',
      targetId: 'draft-2',
      reason: 'release',
      metadata: { slug: 'demo', version: 2 },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid draft without opening a transaction or writing an audit', async () => {
    const invalidDraft = makeDraft({
      modules: [
        {
          id: 'module-1',
          position: 1,
          title: '模块一',
          lessons: [lesson('empty', 1, 5)],
        },
      ],
    });
    invalidDraft.modules[0].lessons[0].content = {
      schemaVersion: 1,
      blocks: [
        { id: 'unknown', type: 'madeUp', props: {} },
        {
          id: 'foreign-image',
          type: 'image',
          props: { assetId: 'foreign', alt: 'Foreign' },
        },
      ],
    } as unknown as (typeof invalidDraft.modules)[0]['lessons'][0]['content'];
    const { service, prisma, audit } = setup({ draft: invalidDraft });

    await expect(
      service.publish('demo', 'ops@example.com', 'release'),
    ).rejects.toMatchObject({
      response: {
        message: '草稿校验未通过',
        problems: expect.arrayContaining([
          expect.stringContaining('未知内容块类型'),
          expect.stringContaining('图片资源不存在'),
        ]),
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns the latest published version as a zero-write, zero-audit no-op', async () => {
    const { service, prisma, audit, drafts } = setup({ published: true });
    const version = { id: 'draft-2', version: 2, publishedAt: new Date() };
    (prisma.courseVersion.findFirst as jest.Mock).mockResolvedValue(version);

    await expect(
      service.publish('demo', 'ops@example.com', 'repeat'),
    ).resolves.toBe(version);
    expect(drafts.requireDraft).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('uses a conditional update so a concurrently published version is not overwritten', async () => {
    const { service, tx, audit } = setup();
    tx.courseVersion.updateMany.mockResolvedValue({ count: 0 });
    tx.courseVersion.findUnique.mockResolvedValue({
      id: 'draft-2',
      publishedAt: new Date(),
    });

    await service.publish('demo', 'ops@example.com', 'release');
    expect(tx.courseVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-2', publishedAt: null },
      }),
    );
    expect(tx.course.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
