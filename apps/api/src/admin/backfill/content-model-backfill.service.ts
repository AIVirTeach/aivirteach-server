import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sliceLessonBody } from '../../courses/lesson-body';

export interface BackfillReport {
  bodies: {
    filled: number;
    unresolved: Array<{ lessonId: string; reason: string }>;
  };
  progress: { filled: number; total: number };
}

type LessonBackfillRow = {
  id: string;
  body: string;
  sourceRange: Prisma.JsonValue | null;
  module: { courseVersion: { sourceMarkdown: string | null } };
};

type ProgressBackfillRow = {
  id: string;
  currentLesson: { contentId: string } | null;
};

@Injectable()
export class ContentModelBackfillService {
  constructor(private readonly prisma: PrismaService) {}

  async run(options: { execute: boolean }): Promise<BackfillReport> {
    const [lessons, progresses] = await Promise.all([
      this.prisma.courseLesson.findMany({
        where: { body: '' },
        select: {
          id: true,
          body: true,
          sourceRange: true,
          module: { select: { courseVersion: { select: { sourceMarkdown: true } } } },
        },
      }),
      this.prisma.progress.findMany({
        where: { currentLessonContentId: null, currentLessonId: { not: null } },
        select: {
          id: true,
          currentLesson: { select: { contentId: true } },
        },
      }),
    ]);

    const unresolved: BackfillReport['bodies']['unresolved'] = [];
    const bodyUpdates: Array<{ id: string; body: string }> = [];
    for (const row of lessons as LessonBackfillRow[]) {
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

    if (options.execute) {
      for (const update of bodyUpdates) {
        await this.prisma.courseLesson.update({
          where: { id: update.id },
          data: { body: update.body },
        });
      }
      for (const update of progressUpdates) {
        await this.prisma.progress.update({
          where: { id: update.id },
          data: { currentLessonContentId: update.contentId },
        });
      }
    }

    return {
      bodies: { filled: bodyUpdates.length, unresolved },
      progress: { filled: progressUpdates.length, total: progresses.length },
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
