import { Injectable } from '@nestjs/common';
import { basename } from 'node:path';
import { Prisma } from '@prisma/client';
import type { ConversionIssue } from '../../courses/lesson-conversion/markdown-to-blocks';
import { convertMarkdownToBlocks } from '../../courses/lesson-conversion/markdown-to-blocks';
import { checkPlainTextEquivalence } from '../../courses/lesson-conversion/plain-text';
import { PrismaService } from '../../prisma/prisma.service';
import { sliceLessonBody } from '../../courses/lesson-body';

export interface BackfillReport {
  bodies: {
    filled: number;
    unresolved: Array<{ lessonId: string; reason: string }>;
  };
  progress: { filled: number; total: number };
  content: {
    filled: number;
    skipped: Array<{ lessonId: string; reason: string }>;
    reports: Array<{ lessonId: string; issues: ConversionIssue[] }>;
  };
}

type LessonBackfillRow = {
  id: string;
  body: string;
  content: Prisma.JsonValue | null;
  sourceRange: Prisma.JsonValue | null;
  module: { courseVersion: { courseId: string; sourceMarkdown: string | null } };
};

type ProgressBackfillRow = {
  id: string;
  currentLessonId: string;
  currentLesson: { contentId: string } | null;
};

@Injectable()
export class ContentModelBackfillService {
  constructor(private readonly prisma: PrismaService) {}

  async run(
    options: { execute: boolean },
    transaction?: Prisma.TransactionClient,
  ): Promise<BackfillReport> {
    if (options.execute && !transaction) {
      return this.prisma.$transaction((tx) => this.run(options, tx));
    }
    const client = transaction ?? this.prisma;
    const [lessons, progresses] = await Promise.all([
      client.courseLesson.findMany({
        where: { OR: [{ body: '' }, { content: { equals: Prisma.DbNull } }] },
        select: {
          id: true,
          body: true,
          content: true,
          sourceRange: true,
          module: { select: { courseVersion: { select: { courseId: true, sourceMarkdown: true } } } },
        },
      }),
      client.progress.findMany({
        where: { currentLessonContentId: null, currentLessonId: { not: null } },
        select: {
          id: true,
          currentLessonId: true,
          currentLesson: { select: { contentId: true } },
        },
      }),
    ]);

    const unresolved: BackfillReport['bodies']['unresolved'] = [];
    const bodyUpdates: Array<{ id: string; body: string }> = [];
    for (const row of lessons as unknown as LessonBackfillRow[]) {
      // Keep the invariant even if a mocked/stale read returns a non-empty body.
      if (row.body !== '') continue;
      const markdown = row.module.courseVersion.sourceMarkdown;
      if (markdown === null) {
        unresolved.push({ lessonId: row.id, reason: '版本没有 sourceMarkdown' });
        continue;
      }
      const range = parseSourceRange(row.sourceRange);
      if (!range) {
        unresolved.push({ lessonId: row.id, reason: '课时没有有效 sourceRange' });
        continue;
      }
      bodyUpdates.push({ id: row.id, body: sliceLessonBody(markdown, range) });
    }

    const progressUpdates = (progresses as ProgressBackfillRow[]).flatMap(
      (row) =>
        row.currentLesson
          ? [{ id: row.id, contentId: row.currentLesson.contentId }]
          : [],
    );

    const contentSkipped: BackfillReport['content']['skipped'] = [];
    const conversionReports: BackfillReport['content']['reports'] = [];
    const contentUpdates: Array<{ id: string; content: Prisma.InputJsonValue }> = [];
    const assetMapByCourse = new Map<string, Map<string, string>>();
    // Convert one lesson at a time: remark ASTs and intermediate blocks become collectible immediately.
    for (const row of lessons as unknown as LessonBackfillRow[]) {
      if (row.content !== null || row.body === '') continue;
      const courseId = row.module.courseVersion.courseId;
      let assetIdsByFilename = assetMapByCourse.get(courseId);
      if (!assetIdsByFilename) {
        const assets = await client.courseAsset.findMany({
          where: { courseId },
          select: { id: true, objectKey: true },
        });
        assetIdsByFilename = new Map(assets.map((asset) => [basename(asset.objectKey), asset.id]));
        assetMapByCourse.set(courseId, assetIdsByFilename);
      }
      const converted = await convertMarkdownToBlocks(row.body, { assetIdsByFilename });
      conversionReports.push({ lessonId: row.id, issues: converted.report });
      const errors = converted.report.filter(({ level }) => level === 'error');
      if (errors.length) {
        contentSkipped.push({
          lessonId: row.id,
          reason: errors.map(({ code, message }) => `${code}: ${message}`).join('; '),
        });
        continue;
      }
      const equivalence = await checkPlainTextEquivalence(row.body, converted);
      if (!equivalence.equal) {
        contentSkipped.push({ lessonId: row.id, reason: '纯文本与 body 不一致' });
        continue;
      }
      contentUpdates.push({ id: row.id, content: converted.content as unknown as Prisma.InputJsonValue });
    }

    let bodyFilled = bodyUpdates.length;
    let progressFilled = progressUpdates.length;
    let contentFilled = contentUpdates.length;
    if (options.execute) {
      bodyFilled = 0;
      for (const update of bodyUpdates) {
        const result = await client.courseLesson.updateMany({
          where: { id: update.id, body: '' },
          data: { body: update.body },
        });
        bodyFilled += result.count;
      }
      progressFilled = 0;
      for (const update of progressUpdates) {
        const row = (progresses as ProgressBackfillRow[]).find(
          (candidate) => candidate.id === update.id,
        );
        if (!row) continue;
        const result = await client.progress.updateMany({
          where: {
            id: update.id,
            currentLessonContentId: null,
            currentLessonId: row.currentLessonId,
          },
          data: { currentLessonContentId: update.contentId },
        });
        progressFilled += result.count;
      }
      contentFilled = 0;
      for (const update of contentUpdates) {
        const result = await client.courseLesson.updateMany({
          where: { id: update.id, content: { equals: Prisma.DbNull } },
          data: { content: update.content },
        });
        contentFilled += result.count;
      }
    }

    return {
      bodies: { filled: bodyFilled, unresolved },
      progress: { filled: progressFilled, total: progresses.length },
      content: { filled: contentFilled, skipped: contentSkipped, reports: conversionReports },
    };
  }
}

function parseSourceRange(value: Prisma.JsonValue | null): {
  startLine: number;
  endLine: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const range = value as Record<string, unknown>;
  if (
    !Number.isInteger(range.startLine) ||
    !Number.isInteger(range.endLine) ||
    (range.startLine as number) < 1 ||
    (range.endLine as number) < (range.startLine as number)
  ) {
    return null;
  }
  return {
    startLine: range.startLine as number,
    endLine: range.endLine as number,
  };
}
