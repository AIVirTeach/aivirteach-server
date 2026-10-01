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
    pendingBody: Array<{ lessonId: string; reason: string }>;
  };
}

export interface PreparedBackfill {
  report: BackfillReport;
  bodyUpdates: Array<{ id: string; body: string }>;
  progressUpdates: Array<{
    id: string;
    currentLessonId: string;
    contentId: string;
  }>;
  contentUpdates: Array<{
    id: string;
    expectedBody: string;
    content: Prisma.InputJsonValue;
  }>;
}

type LessonBackfillRow = {
  id: string;
  body: string;
  content: Prisma.JsonValue | null;
  sourceRange: Prisma.JsonValue | null;
  module: {
    courseVersion: { courseId: string; sourceMarkdown: string | null };
  };
};

type ProgressBackfillRow = {
  id: string;
  currentLessonId: string;
  currentLesson: { contentId: string } | null;
};

@Injectable()
export class ContentModelBackfillService {
  constructor(private readonly prisma: PrismaService) {}

  async prepare(): Promise<PreparedBackfill> {
    const client = this.prisma;
    const [lessons, progresses] = await Promise.all([
      client.courseLesson.findMany({
        where: { OR: [{ body: '' }, { content: { equals: Prisma.DbNull } }] },
        select: {
          id: true,
          body: true,
          content: true,
          sourceRange: true,
          module: {
            select: {
              courseVersion: {
                select: { courseId: true, sourceMarkdown: true },
              },
            },
          },
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
        unresolved.push({
          lessonId: row.id,
          reason: '版本没有 sourceMarkdown',
        });
        continue;
      }
      const range = parseSourceRange(row.sourceRange);
      if (!range) {
        unresolved.push({
          lessonId: row.id,
          reason: '课时没有有效 sourceRange',
        });
        continue;
      }
      bodyUpdates.push({ id: row.id, body: sliceLessonBody(markdown, range) });
    }

    const progressUpdates = (progresses as ProgressBackfillRow[]).flatMap(
      (row) =>
        row.currentLesson
          ? [
              {
                id: row.id,
                currentLessonId: row.currentLessonId,
                contentId: row.currentLesson.contentId,
              },
            ]
          : [],
    );

    const contentSkipped: BackfillReport['content']['skipped'] = [];
    const pendingBody: BackfillReport['content']['pendingBody'] = [];
    const conversionReports: BackfillReport['content']['reports'] = [];
    const contentUpdates: PreparedBackfill['contentUpdates'] = [];
    const preparedBodyById = new Map(
      bodyUpdates.map(({ id, body }) => [id, body]),
    );
    const assetMapByCourse = new Map<string, Map<string, string>>();
    // Convert one lesson at a time: remark ASTs and intermediate blocks become collectible immediately.
    for (const row of lessons as unknown as LessonBackfillRow[]) {
      if (row.content !== null) continue;
      const expectedBody =
        row.body === '' ? preparedBodyById.get(row.id) : row.body;
      if (expectedBody === undefined) {
        const reason =
          unresolved.find(({ lessonId }) => lessonId === row.id)?.reason ??
          '课时正文未能准备';
        pendingBody.push({ lessonId: row.id, reason });
        continue;
      }
      const courseId = row.module.courseVersion.courseId;
      let assetIdsByFilename = assetMapByCourse.get(courseId);
      if (!assetIdsByFilename) {
        const assets = await client.courseAsset.findMany({
          where: { courseId },
          select: { id: true, objectKey: true },
        });
        assetIdsByFilename = new Map(
          assets.map((asset) => [basename(asset.objectKey), asset.id]),
        );
        assetMapByCourse.set(courseId, assetIdsByFilename);
      }
      const converted = await convertMarkdownToBlocks(expectedBody, {
        assetIdsByFilename,
      });
      conversionReports.push({ lessonId: row.id, issues: converted.report });
      const errors = converted.report.filter(({ level }) => level === 'error');
      if (errors.length) {
        contentSkipped.push({
          lessonId: row.id,
          reason: errors
            .map(({ code, message }) => `${code}: ${message}`)
            .join('; '),
        });
        continue;
      }
      const equivalence = await checkPlainTextEquivalence(
        expectedBody,
        converted,
      );
      if (!equivalence.equal) {
        contentSkipped.push({
          lessonId: row.id,
          reason: '纯文本与 body 不一致',
        });
        continue;
      }
      contentUpdates.push({
        id: row.id,
        expectedBody,
        content: converted.content as unknown as Prisma.InputJsonValue,
      });
    }

    return {
      report: {
        bodies: { filled: bodyUpdates.length, unresolved },
        progress: { filled: progressUpdates.length, total: progresses.length },
        content: {
          filled: contentUpdates.length,
          skipped: contentSkipped,
          reports: conversionReports,
          pendingBody,
        },
      },
      bodyUpdates,
      progressUpdates,
      contentUpdates,
    };
  }

  async apply(
    plan: PreparedBackfill,
    transaction: Prisma.TransactionClient,
  ): Promise<BackfillReport> {
    let bodyFilled = 0;
    for (const update of plan.bodyUpdates) {
      const result = await transaction.courseLesson.updateMany({
        where: { id: update.id, body: '' },
        data: { body: update.body },
      });
      bodyFilled += result.count;
    }
    let progressFilled = 0;
    for (const update of plan.progressUpdates) {
      const result = await transaction.progress.updateMany({
        where: {
          id: update.id,
          currentLessonContentId: null,
          currentLessonId: update.currentLessonId,
        },
        data: { currentLessonContentId: update.contentId },
      });
      progressFilled += result.count;
    }
    let contentFilled = 0;
    for (const update of plan.contentUpdates) {
      const result = await transaction.courseLesson.updateMany({
        where: {
          id: update.id,
          content: { equals: Prisma.DbNull },
          body: update.expectedBody,
        },
        data: { content: update.content },
      });
      contentFilled += result.count;
    }
    return {
      ...plan.report,
      bodies: { ...plan.report.bodies, filled: bodyFilled },
      progress: { ...plan.report.progress, filled: progressFilled },
      content: { ...plan.report.content, filled: contentFilled },
    };
  }

  async run(options: { execute: boolean }): Promise<BackfillReport> {
    const plan = await this.prepare();
    if (!options.execute) return plan.report;
    return this.prisma.$transaction((transaction) =>
      this.apply(plan, transaction),
    );
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
