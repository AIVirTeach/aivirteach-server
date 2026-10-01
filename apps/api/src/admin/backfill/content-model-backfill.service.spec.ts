import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import { sliceLessonBody } from '../../courses/lesson-body';
import { ContentModelBackfillService } from './content-model-backfill.service';

describe('ContentModelBackfillService', () => {
  const markdownPromise = readFile(
    join(__dirname, '../../courses/__fixtures__/sample-course/lesson-source.md'),
    'utf8',
  );

  const createPrisma = () => {
    const prisma = {
      courseLesson: { findMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      progress: { findMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(prisma));
    return prisma;
  };

  it('仅为 body 为空且有来源的课时切片，并将旧进度 id 转成 contentId', async () => {
    const markdown = await markdownPromise;
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      { id: 'l1', body: '', sourceRange: { startLine: 3, endLine: 4 }, module: { courseVersion: { sourceMarkdown: markdown } } },
      { id: 'l2', body: '', sourceRange: { startLine: 5, endLine: 6 }, module: { courseVersion: { sourceMarkdown: markdown } } },
      { id: 'existing', body: 'keep me', sourceRange: { startLine: 1, endLine: 1 }, module: { courseVersion: { sourceMarkdown: markdown } } },
      { id: 'unresolved', body: '', sourceRange: { startLine: 1, endLine: 1 }, module: { courseVersion: { sourceMarkdown: null } } },
    ]);
    prisma.progress.findMany.mockResolvedValue([
      { id: 'p1', currentLessonId: 'legacy_lesson', currentLesson: { contentId: 'verify-network' } },
      { id: 'p2', currentLessonId: 'missing_lesson', currentLesson: null },
    ]);
    const service = new ContentModelBackfillService(prisma as unknown as PrismaService);

    const report = await service.run({ execute: true });

    expect(report).toEqual({
      bodies: { filled: 2, unresolved: [{ lessonId: 'unresolved', reason: '版本没有 sourceMarkdown' }] },
      progress: { filled: 1, total: 2 },
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
      where: { id: 'p1', currentLessonContentId: null, currentLessonId: 'legacy_lesson' },
      data: { currentLessonContentId: 'verify-network' },
    });
    expect(prisma.progress.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('dry-run 统计相同的改动但不写数据库', async () => {
    const markdown = await markdownPromise;
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      { id: 'l1', body: '', sourceRange: { startLine: 3, endLine: 4 }, module: { courseVersion: { sourceMarkdown: markdown } } },
    ]);
    prisma.progress.findMany.mockResolvedValue([
      { id: 'p1', currentLessonId: 'legacy_lesson', currentLesson: { contentId: 'verify-network' } },
    ]);
    const service = new ContentModelBackfillService(prisma as unknown as PrismaService);

    const report = await service.run({ execute: false });

    expect(report).toEqual({ bodies: { filled: 1, unresolved: [] }, progress: { filled: 1, total: 1 } });
    expect(prisma.courseLesson.updateMany).not.toHaveBeenCalled();
    expect(prisma.progress.updateMany).not.toHaveBeenCalled();
  });

  it('CAS 未命中时不计入成功回填数量', async () => {
    const markdown = await markdownPromise;
    const prisma = createPrisma();
    prisma.courseLesson.findMany.mockResolvedValue([
      { id: 'raced_lesson', body: '', sourceRange: { startLine: 3, endLine: 4 }, module: { courseVersion: { sourceMarkdown: markdown } } },
    ]);
    prisma.courseLesson.updateMany.mockResolvedValue({ count: 0 });
    prisma.progress.findMany.mockResolvedValue([
      { id: 'raced_progress', currentLessonId: 'old_id', currentLesson: { contentId: 'verify-network' } },
    ]);
    prisma.progress.updateMany.mockResolvedValue({ count: 0 });
    const service = new ContentModelBackfillService(prisma as unknown as PrismaService);

    const report = await service.run({ execute: true });

    expect(report).toEqual({ bodies: { filled: 0, unresolved: [] }, progress: { filled: 0, total: 1 } });
    expect(prisma.courseLesson.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'raced_lesson', body: '' } }));
    expect(prisma.progress.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'raced_progress', currentLessonContentId: null, currentLessonId: 'old_id' },
    }));
  });
});
