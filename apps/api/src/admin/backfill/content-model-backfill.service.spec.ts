import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sliceLessonBody } from '../../courses/lesson-body';
import { ContentModelBackfillService } from './content-model-backfill.service';
import * as equivalence from '../../courses/lesson-conversion/plain-text';

jest.mock('../../courses/lesson-conversion/plain-text', () => ({
  ...jest.requireActual('../../courses/lesson-conversion/plain-text'),
  checkPlainTextEquivalence: jest.fn(),
}));

describe('ContentModelBackfillService', () => {
  const markdownPromise = readFile(
    join(
      __dirname,
      '../../courses/__fixtures__/sample-course/lesson-source.md',
    ),
    'utf8',
  );

  const createPrisma = () => {
    const prisma = {
      courseLesson: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      courseAsset: { findMany: jest.fn().mockResolvedValue([]) },
      progress: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) => callback(prisma),
    );
    return prisma;
  };

  it('仅为 body 为空且有来源的课时切片，并将旧进度 id 转成 contentId', async () => {
    const markdown = await markdownPromise;
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'l1',
        body: '',
        sourceRange: { startLine: 3, endLine: 4 },
        module: { courseVersion: { sourceMarkdown: markdown } },
      },
      {
        id: 'l2',
        body: '',
        sourceRange: { startLine: 5, endLine: 6 },
        module: { courseVersion: { sourceMarkdown: markdown } },
      },
      {
        id: 'existing',
        body: 'keep me',
        sourceRange: { startLine: 1, endLine: 1 },
        module: { courseVersion: { sourceMarkdown: markdown } },
      },
      {
        id: 'unresolved',
        body: '',
        sourceRange: { startLine: 1, endLine: 1 },
        module: { courseVersion: { sourceMarkdown: null } },
      },
    ]);
    prisma.progress.findMany.mockResolvedValue([
      {
        id: 'p1',
        currentLessonId: 'legacy_lesson',
        currentLesson: { contentId: 'verify-network' },
      },
      { id: 'p2', currentLessonId: 'missing_lesson', currentLesson: null },
    ]);
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const report = await service.run({ execute: true });

    expect(report).toEqual({
      bodies: {
        filled: 2,
        unresolved: [
          { lessonId: 'unresolved', reason: '版本没有 sourceMarkdown' },
        ],
      },
      progress: { filled: 1, total: 2 },
      content: { filled: 0, skipped: [], reports: [], pendingBody: [] },
    });
    expect(prisma.courseLesson.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'l1', body: '' },
      data: { body: sliceLessonBody(markdown, { startLine: 3, endLine: 4 }) },
    });
    expect(prisma.courseLesson.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'l2', body: '' },
      data: { body: sliceLessonBody(markdown, { startLine: 5, endLine: 6 }) },
    });
    expect(prisma.progress.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        currentLessonContentId: null,
        currentLessonId: 'legacy_lesson',
      },
      data: { currentLessonContentId: 'verify-network' },
    });
    expect(prisma.progress.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('dry-run 统计相同的改动但不写数据库', async () => {
    const markdown = await markdownPromise;
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'l1',
        body: '',
        sourceRange: { startLine: 3, endLine: 4 },
        module: { courseVersion: { sourceMarkdown: markdown } },
      },
    ]);
    prisma.progress.findMany.mockResolvedValue([
      {
        id: 'p1',
        currentLessonId: 'legacy_lesson',
        currentLesson: { contentId: 'verify-network' },
      },
    ]);
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const report = await service.run({ execute: false });

    expect(report).toEqual({
      bodies: { filled: 1, unresolved: [] },
      progress: { filled: 1, total: 1 },
      content: { filled: 0, skipped: [], reports: [], pendingBody: [] },
    });
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();
    expect(prisma.progress.updateMany).not.toHaveBeenCalled();
  });

  it('CAS 未命中时不计入成功回填数量', async () => {
    const markdown = await markdownPromise;
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'raced_lesson',
        body: '',
        sourceRange: { startLine: 3, endLine: 4 },
        module: { courseVersion: { sourceMarkdown: markdown } },
      },
    ]);
    prisma.courseLesson.updateMany.mockResolvedValue({ count: 0 });
    prisma.progress.findMany.mockResolvedValue([
      {
        id: 'raced_progress',
        currentLessonId: 'old_id',
        currentLesson: { contentId: 'verify-network' },
      },
    ]);
    prisma.progress.updateMany.mockResolvedValue({ count: 0 });
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const report = await service.run({ execute: true });

    expect(report).toEqual({
      bodies: { filled: 0, unresolved: [] },
      progress: { filled: 0, total: 1 },
      content: { filled: 0, skipped: [], reports: [], pendingBody: [] },
    });
    expect(prisma.courseLesson.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'raced_lesson', body: '' } }),
    );
    expect(prisma.progress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'raced_progress',
          currentLessonContentId: null,
          currentLessonId: 'old_id',
        },
      }),
    );
  });
  it('converts eligible content, checks equivalence, and respects dry-run', async () => {
    const prisma = createPrisma();
    prisma.courseAsset.findMany.mockResolvedValue([
      { id: 'asset-a', objectKey: 'courses/course-1/a.png' },
    ]);
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'lesson-1',
        body: '## hello\n\n![A](./a.png)',
        content: null,
        module: {
          courseVersion: { courseId: 'course-1', sourceMarkdown: null },
        },
      },
      {
        id: 'already-set',
        body: 'do not replace',
        content: { schemaVersion: 1, blocks: [] },
        module: {
          courseVersion: { courseId: 'course-1', sourceMarkdown: null },
        },
      },
    ]);
    prisma.progress.findMany.mockResolvedValue([]);
    jest
      .mocked(equivalence.checkPlainTextEquivalence)
      .mockResolvedValue({ equal: true, expected: 'hello', actual: 'hello' });
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const preview = await service.run({ execute: false });
    expect(preview.content.filled).toBe(1);
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();

    const report = await service.run({ execute: true });
    expect(report.content).toEqual({
      filled: 1,
      skipped: [],
      reports: [{ lessonId: 'lesson-1', issues: [] }],
      pendingBody: [],
    });
    expect(prisma.courseLesson.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'lesson-1',
        content: { equals: Prisma.DbNull },
        body: '## hello\n\n![A](./a.png)',
      },
      data: {
        content: expect.objectContaining({
          schemaVersion: 1,
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'image',
              props: expect.objectContaining({ assetId: 'asset-a' }),
            }),
          ]),
        }),
      },
    });
    expect(prisma.courseLesson.updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips oversized converter output, equivalence mismatches, and existing content', async () => {
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'oversized',
        body: `\`\`\`\n${'x'.repeat(21_000)}\n\`\`\``,
        content: null,
        module: { courseVersion: { courseId: 'c', sourceMarkdown: null } },
      },
      {
        id: 'mismatch',
        body: 'source',
        content: null,
        module: { courseVersion: { courseId: 'c', sourceMarkdown: null } },
      },
      {
        id: 'existing',
        body: 'existing',
        content: { schemaVersion: 1, blocks: [] },
        module: { courseVersion: { courseId: 'c', sourceMarkdown: null } },
      },
    ]);
    prisma.progress.findMany.mockResolvedValue([]);
    jest.mocked(equivalence.checkPlainTextEquivalence).mockResolvedValue({
      equal: false,
      expected: 'source',
      actual: 'changed',
    });
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const report = await service.run({ execute: true });

    expect(report.content.skipped).toEqual([
      expect.objectContaining({ lessonId: 'oversized' }),
      { lessonId: 'mismatch', reason: '纯文本与 body 不一致' },
    ]);
    expect(
      report.content.reports.find(({ lessonId }) => lessonId === 'oversized')
        ?.issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: 'error' })]),
    );
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();
  });

  it('finishes asset reads and equivalence checks before opening the execute transaction', async () => {
    const prisma = createPrisma();
    const events: string[] = [];
    prisma.courseLesson.findMany.mockImplementation(async () => {
      events.push('lesson-read');
      return [
        {
          id: 'lesson-1',
          body: 'plain text',
          content: null,
          module: { courseVersion: { courseId: 'c', sourceMarkdown: null } },
        },
      ];
    });
    prisma.courseAsset.findMany.mockImplementation(async () => {
      events.push('asset-read');
      return [];
    });
    prisma.progress.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) => {
        events.push('transaction-start');
        return callback(prisma);
      },
    );
    jest
      .mocked(equivalence.checkPlainTextEquivalence)
      .mockImplementation(async (...args) => {
        events.push('equivalence');
        return { equal: true, expected: args[0], actual: args[0] };
      });
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    await service.run({ execute: true });

    expect(events).toEqual([
      'lesson-read',
      'asset-read',
      'equivalence',
      'transaction-start',
    ]);
  });

  it('converts a body prepared from source and CAS-gates content on that expected body', async () => {
    const markdown = await markdownPromise;
    const expectedBody = sliceLessonBody(markdown, {
      startLine: 3,
      endLine: 4,
    });
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'body-empty',
        body: '',
        content: null,
        sourceRange: { startLine: 3, endLine: 4 },
        module: {
          courseVersion: { courseId: 'course-1', sourceMarkdown: markdown },
        },
      },
    ]);
    prisma.progress.findMany.mockResolvedValue([]);
    jest.mocked(equivalence.checkPlainTextEquivalence).mockResolvedValue({
      equal: true,
      expected: expectedBody,
      actual: expectedBody,
    });
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const report = await service.run({ execute: true });

    expect(report.bodies.filled).toBe(1);
    expect(report.content.filled).toBe(1);
    expect(prisma.courseLesson.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'body-empty', body: '' },
      data: { body: expectedBody },
    });
    expect(prisma.courseLesson.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'body-empty',
        content: { equals: Prisma.DbNull },
        body: expectedBody,
      },
      data: { content: expect.any(Object) },
    });
  });

  it('reports content pending on body preparation so operators know another run is needed', async () => {
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      {
        id: 'missing-source',
        body: '',
        content: null,
        sourceRange: { startLine: 1, endLine: 1 },
        module: {
          courseVersion: { courseId: 'course-1', sourceMarkdown: null },
        },
      },
    ]);
    prisma.progress.findMany.mockResolvedValue([]);
    const service = new ContentModelBackfillService(
      prisma as unknown as PrismaService,
    );

    const report = await service.run({ execute: false });

    expect(report.content.pendingBody).toEqual([
      { lessonId: 'missing-source', reason: '版本没有 sourceMarkdown' },
    ]);
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();
  });
});
