export type EnrollmentStatus = 'not_started' | 'in_progress' | 'completed';
type ProgressPointer = { currentLessonContentId: string | null } | null;
type ModulesWithLessons = Array<{
  title: string;
  lessons: Array<{ contentId: string }>;
}>;
type Completion = {
  generation: number;
  contentId: string;
  completedAt: Date | null;
};
type ProgressInput = {
  progress: ProgressPointer;
  modules: ModulesWithLessons;
  generation?: number;
  lessonProgress?: Completion[];
};

export function completedLessonIds(input: ProgressInput): string[] {
  const completed = new Set(
    (input.lessonProgress ?? [])
      .filter(
        (row) => row.generation === (input.generation ?? 0) && row.completedAt,
      )
      .map((row) => row.contentId),
  );
  return [
    ...new Set(
      input.modules.flatMap((module) =>
        module.lessons.map((lesson) => lesson.contentId),
      ),
    ),
  ].filter((id) => completed.has(id));
}

export function computeProgressPercent(input: ProgressInput): number {
  const total = new Set(
    input.modules.flatMap((module) =>
      module.lessons.map((lesson) => lesson.contentId),
    ),
  ).size;
  return total
    ? Math.round((completedLessonIds(input).length / total) * 100)
    : 0;
}

export function deriveCurrentModuleTitle(input: ProgressInput): string {
  return (
    input.modules.find((module) =>
      module.lessons.some(
        (lesson) => lesson.contentId === input.progress?.currentLessonContentId,
      ),
    )?.title ?? ''
  );
}

export function deriveEnrollmentView(
  input: ProgressInput & {
    active?: boolean;
    completedAt: Date | null;
  },
): { status: EnrollmentStatus; progressPercent: number } {
  const progressPercent = computeProgressPercent(input);
  const total = input.modules.flatMap((module) => module.lessons).length;
  const complete = total > 0 && completedLessonIds(input).length === total;
  return {
    status: complete
      ? 'completed'
      : input.active ||
          input.progress?.currentLessonContentId ||
          progressPercent > 0 ||
          input.completedAt
        ? 'in_progress'
        : 'not_started',
    progressPercent,
  };
}
