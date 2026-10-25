import type { LessonSaveResult } from '@aivirteach/admin-contract';

export type ContentProblem = LessonSaveResult['problems']['errors'][number];

export type LocatedProblem = ContentProblem & { elementId: string };
export function fieldAttributes(
  path: readonly (string | number)[],
  problems: readonly LocatedProblem[],
) {
  const key = JSON.stringify(path);
  const own = problems.filter(
    (problem) =>
      problem.level === 'error' && JSON.stringify(problem.fieldPath) === key,
  );
  return {
    'data-field-path': key,
    'aria-invalid': own.length ? true : undefined,
    'aria-describedby': own.length
      ? own.map((problem) => problem.elementId).join(' ')
      : undefined,
  };
}
