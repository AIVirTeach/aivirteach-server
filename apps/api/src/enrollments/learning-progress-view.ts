import {
  completedLessonIds as stateCompletedLessonIds,
  type LearningState,
} from './learning-state';

export type EnrollmentStatus = 'not_started' | 'in_progress' | 'completed';
type ModulesWithLessons = Array<{
  title: string;
  lessons: Array<{ contentId: string }>;
}>;

export type LearningProgressInput = {
  learningState: LearningState;
  modules: ModulesWithLessons;
  active?: boolean;
};

export function completedLessonIds(input: LearningProgressInput): string[] {
  const completed = new Set(stateCompletedLessonIds(input.learningState));
  return [
    ...new Set(input.modules.flatMap((m) => m.lessons.map((l) => l.contentId))),
  ].filter((id) => completed.has(id));
}

export function computeProgressPercent(input: LearningProgressInput): number {
  const total = new Set(
    input.modules.flatMap((m) => m.lessons.map((l) => l.contentId)),
  ).size;
  return total
    ? Math.round((completedLessonIds(input).length / total) * 100)
    : 0;
}

export function deriveCurrentModuleTitle(input: LearningProgressInput): string {
  return (
    input.modules.find((module) =>
      module.lessons.some(
        (lesson) => lesson.contentId === input.learningState.readingLessonId,
      ),
    )?.title ?? ''
  );
}

export function deriveEnrollmentView(input: LearningProgressInput): {
  status: EnrollmentStatus;
  progressPercent: number;
} {
  const progressPercent = computeProgressPercent(input);
  const ids = new Set(
    input.modules.flatMap((module) =>
      module.lessons.map((lesson) => lesson.contentId),
    ),
  );
  const complete =
    ids.size > 0 && completedLessonIds(input).length === ids.size;
  return {
    status: complete
      ? 'completed'
      : input.active ||
          input.learningState.readingLessonId ||
          progressPercent > 0 ||
          input.learningState.completedAt
        ? 'in_progress'
        : 'not_started',
    progressPercent,
  };
}
