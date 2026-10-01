import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type ModuleRow = Prisma.CourseModuleGetPayload<{
  include: { lessons: true };
}>;

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
  markdown: string;
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
    markdown: lesson.body,
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
