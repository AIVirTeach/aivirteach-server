import { z } from 'zod';

const lessonStateSchema = z.object({
  completedAt: z.string().datetime().nullable(),
  firstCompletedAt: z.string().datetime().nullable(),
});

const learningStateSchema = z.object({
  schemaVersion: z.literal(1),
  readingLessonId: z.string().nullable(),
  lessons: z.record(z.string(), lessonStateSchema),
  completedAt: z.string().datetime().nullable(),
});

export type LessonLearningState = z.infer<typeof lessonStateSchema>;
export type LearningState = z.infer<typeof learningStateSchema>;

export const EMPTY_LEARNING_STATE: LearningState = {
  schemaVersion: 1,
  readingLessonId: null,
  lessons: {},
  completedAt: null,
};

export function parseLearningState(value: unknown): LearningState {
  const parsed = learningStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Enrollment.learningState has an unsupported shape');
  }
  return parsed.data;
}

export function setReadingPosition(
  state: LearningState,
  lessonId: string,
): LearningState {
  return { ...state, readingLessonId: lessonId };
}

export function setLessonCompletion(
  state: LearningState,
  lessonId: string,
  completed: boolean,
  now: Date,
): LearningState {
  const previous = state.lessons[lessonId];
  const completedAt = completed ? now.toISOString() : null;
  return {
    ...state,
    lessons: {
      ...state.lessons,
      [lessonId]: {
        completedAt,
        firstCompletedAt:
          previous?.firstCompletedAt ?? (completed ? completedAt : null),
      },
    },
  };
}

export function withCourseCompletion(
  state: LearningState,
  completedAt: string | null,
): LearningState {
  return { ...state, completedAt };
}

export function completedLessonIds(state: LearningState): string[] {
  return Object.entries(state.lessons)
    .filter(([, lesson]) => lesson.completedAt !== null)
    .map(([id]) => id);
}

export function remapReadingPosition(
  state: LearningState,
  removedToReplacement: ReadonlyMap<string, string>,
): LearningState {
  const replacement = state.readingLessonId
    ? removedToReplacement.get(state.readingLessonId)
    : undefined;
  return replacement ? { ...state, readingLessonId: replacement } : state;
}
