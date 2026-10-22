import {
  completedLessonIds,
  deriveCurrentModuleTitle,
  deriveEnrollmentView,
} from './enrollment-view';
const modules = [
  { title: 'One', lessons: [{ contentId: 'a' }, { contentId: 'b' }] },
];
const base = {
  active: true,
  completedAt: null,
  progress: null,
  modules,
  generation: 1,
};
const done = (contentId: string, generation = 1) => ({
  contentId,
  generation,
  completedAt: new Date(),
});

describe('per-lesson progress projection', () => {
  it('never infers completion from reading position or legacy achievement', () => {
    expect(
      deriveEnrollmentView({
        ...base,
        completedAt: new Date(),
        progress: { currentLessonContentId: 'b' },
      }),
    ).toEqual({ status: 'in_progress', progressPercent: 0 });
  });
  it('counts a skipped-to final lesson as one lesson, not the whole course', () => {
    expect(
      deriveEnrollmentView({ ...base, lessonProgress: [done('b')] }),
    ).toEqual({ status: 'in_progress', progressPercent: 50 });
  });
  it('excludes previous generations, removed lessons and unmarked records', () => {
    expect(
      completedLessonIds({
        ...base,
        lessonProgress: [
          done('a', 0),
          done('removed'),
          { ...done('b'), completedAt: null },
        ],
      }),
    ).toEqual([]);
  });
  it('preserves completion on reorder and text edits but added lessons start pending', () => {
    const lessonProgress = [done('a'), done('b')];
    expect(deriveEnrollmentView({ ...base, lessonProgress })).toEqual({
      status: 'completed',
      progressPercent: 100,
    });
    expect(
      deriveEnrollmentView({
        ...base,
        lessonProgress,
        modules: [
          {
            title: 'Edited',
            lessons: [
              { contentId: 'b' },
              { contentId: 'a' },
              { contentId: 'c' },
            ],
          },
        ],
      }),
    ).toEqual({ status: 'in_progress', progressPercent: 67 });
  });
  it('does not call an empty syllabus completed', () => {
    expect(
      deriveEnrollmentView({ ...base, active: false, modules: [] }),
    ).toEqual({ status: 'not_started', progressPercent: 0 });
  });
  it('module title comes from reading position independently of completion', () => {
    expect(
      deriveCurrentModuleTitle({
        ...base,
        progress: { currentLessonContentId: 'b' },
        lessonProgress: [],
      }),
    ).toBe('One');
  });
});
