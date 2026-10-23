import {
  deriveCurrentModuleTitle,
  deriveEnrollmentView,
} from './learning-progress-view';
import {
  EMPTY_LEARNING_STATE,
  parseLearningState,
  setLessonCompletion,
  setReadingPosition,
} from './learning-state';

const modules = [
  { title: 'One', lessons: [{ contentId: 'a' }, { contentId: 'b' }] },
];

describe('learning state projection and transitions', () => {
  it('reading is independent from completion and all progress uses stable ids', () => {
    const read = setReadingPosition(EMPTY_LEARNING_STATE, 'b');
    expect(
      deriveEnrollmentView({ learningState: read, modules, active: true }),
    ).toEqual({ status: 'in_progress', progressPercent: 0 });
    const completed = setLessonCompletion(
      read,
      'b',
      true,
      new Date('2026-10-23T00:00:00.000Z'),
    );
    expect(
      deriveEnrollmentView({ learningState: completed, modules, active: true }),
    ).toEqual({ status: 'in_progress', progressPercent: 50 });
    expect(
      deriveCurrentModuleTitle({ learningState: completed, modules }),
    ).toBe('One');
  });

  it('preserves first lesson completion time while allowing the current mark to change', () => {
    const first = new Date('2026-10-23T00:00:00.000Z');
    const second = new Date('2026-10-24T00:00:00.000Z');
    const completed = setLessonCompletion(
      EMPTY_LEARNING_STATE,
      'a',
      true,
      first,
    );
    const unmarked = setLessonCompletion(completed, 'a', false, second);
    const remarked = setLessonCompletion(unmarked, 'a', true, second);
    expect(remarked.lessons.a).toEqual({
      completedAt: second.toISOString(),
      firstCompletedAt: first.toISOString(),
    });
  });

  it('filters removed syllabus ids and lessons currently unmarked', () => {
    const state = {
      ...EMPTY_LEARNING_STATE,
      lessons: {
        a: { completedAt: null, firstCompletedAt: '2026-10-20T00:00:00.000Z' },
        removed: {
          completedAt: '2026-10-20T00:00:00.000Z',
          firstCompletedAt: '2026-10-20T00:00:00.000Z',
        },
      },
    };
    expect(
      deriveEnrollmentView({ learningState: state, modules, active: true }),
    ).toEqual({ status: 'in_progress', progressPercent: 0 });
  });

  it('retains completion through reorder and starts added stable ids pending', () => {
    const state = {
      ...EMPTY_LEARNING_STATE,
      lessons: Object.fromEntries(
        ['a', 'b'].map((id) => [
          id,
          {
            completedAt: '2026-10-20T00:00:00.000Z',
            firstCompletedAt: '2026-10-20T00:00:00.000Z',
          },
        ]),
      ),
    };
    expect(
      deriveEnrollmentView({
        learningState: state,
        modules: [
          {
            title: 'Reordered',
            lessons: [
              { contentId: 'b' },
              { contentId: 'a' },
              { contentId: 'c' },
            ],
          },
        ],
        active: true,
      }),
    ).toEqual({ status: 'in_progress', progressPercent: 67 });
  });

  it('does not infer lesson completion from a course achievement timestamp', () => {
    const state = {
      ...EMPTY_LEARNING_STATE,
      completedAt: '2026-10-20T00:00:00.000Z',
    };
    expect(
      deriveEnrollmentView({ learningState: state, modules, active: false }),
    ).toEqual({ status: 'in_progress', progressPercent: 0 });
  });

  it('does not report an empty syllabus as completed', () => {
    const state = {
      ...EMPTY_LEARNING_STATE,
      completedAt: '2026-10-20T00:00:00.000Z',
    };
    expect(
      deriveEnrollmentView({ learningState: state, modules: [], active: false })
        .status,
    ).toBe('in_progress');
  });

  it('parses persisted JSON at the boundary and rejects unknown shapes', () => {
    expect(parseLearningState(EMPTY_LEARNING_STATE)).toEqual(
      EMPTY_LEARNING_STATE,
    );
    expect(() => parseLearningState({ readingLessonId: 'a' })).toThrow(
      'unsupported shape',
    );
  });
});
