import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  LessonEnvelopeSchema,
  collectImageAssetIds,
} from '@aivirteach/lesson-blocks';
import type { LessonBlock } from '@aivirteach/lesson-blocks';

type LessonRow = Prisma.CourseLessonGetPayload<object>;
type ModuleRow = Prisma.CourseModuleGetPayload<object> & {
  // body/content 只在被读取的那一课上必须有；其余课时只用来算导航。
  lessons: Array<
    Omit<LessonRow, 'body' | 'content'> &
      Partial<Pick<LessonRow, 'body' | 'content'>>
  >;
};

export type LessonResponse = {
  courseId: string;
  module: { id: string; title: string; position: number };
  lesson: {
    id: string;
    position: number;
    title: string;
    estimatedMinutes: number;
    objectives: string[];
    activity: { type: string; prompt: string; completionType: string };
  };
  /** @deprecated 迁移 B 删除；迁移期供旧 client 回退。 */
  markdown: string;
  blocks: LessonBlock[] | null;
  assets: Record<string, { url: string; alt?: string }>;
  assessment: null;
  navigation: {
    previousLessonId: string | null;
    nextLessonId: string | null;
    index: number;
    total: number;
  };
};

export function buildLessonResponse(input: {
  courseSlug: string;
  modules: ModuleRow[];
  lessonId: string;
  courseAssets: Array<{
    id: string;
    objectKey: string;
    altText: string | null;
  }>;
}): LessonResponse {
  const flattened = input.modules.flatMap((courseModule) =>
    courseModule.lessons.map((lesson) => ({ courseModule, lesson })),
  );
  const index = flattened.findIndex(
    ({ lesson }) => lesson.contentId === input.lessonId,
  );
  if (index === -1) {
    throw new NotFoundException(
      `课程 ${input.courseSlug} 里找不到课时：${input.lessonId}`,
    );
  }

  const { courseModule, lesson } = flattened[index];
  const parsedContent = LessonEnvelopeSchema.safeParse(lesson.content ?? null);
  const blocks = parsedContent.success ? parsedContent.data.blocks : null;
  const referencedAssetIds = new Set(
    collectImageAssetIds(lesson.content ?? null),
  );
  const assets = Object.fromEntries(
    input.courseAssets
      .filter((asset) => referencedAssetIds.has(asset.id))
      .map((asset) => [
        asset.id,
        {
          url: asset.objectKey,
          ...(asset.altText === null ? {} : { alt: asset.altText }),
        },
      ]),
  );
  return {
    courseId: input.courseSlug,
    module: {
      id: courseModule.id,
      title: courseModule.title,
      position: courseModule.position,
    },
    lesson: {
      id: lesson.contentId,
      position: lesson.position,
      title: lesson.title,
      estimatedMinutes: lesson.estimatedMinutes,
      objectives: lesson.objectives,
      activity: {
        type: lesson.activityType,
        prompt: lesson.activityPrompt,
        completionType: lesson.activityCompletionType,
      },
    },
    markdown: lesson.body ?? '',
    blocks,
    assets,
    // LessonAssessment 行要等 assessments.json 落地才会存在，这轮之前先固定返回 null。
    assessment: null,
    navigation: {
      previousLessonId: flattened[index - 1]?.lesson.contentId ?? null,
      nextLessonId: flattened[index + 1]?.lesson.contentId ?? null,
      index,
      total: flattened.length,
    },
  };
}
