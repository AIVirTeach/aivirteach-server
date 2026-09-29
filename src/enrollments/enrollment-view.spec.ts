import { computeProgressPercent, deriveEnrollmentStatus, deriveEnrollmentView } from './enrollment-view';

const FOUR_LESSONS = [{ lessons: [{ id: 'l1' }, { id: 'l2' }] }, { lessons: [{ id: 'l3' }, { id: 'l4' }] }];

describe('deriveEnrollmentStatus', () => {
  it('有 completedAt 时是 completed（学完最后一课后课时指针会被清空，不能只看指针）', () => {
    expect(deriveEnrollmentStatus({ completedAt: new Date(), currentLessonId: null })).toBe('completed');
  });

  it('没有 completedAt、课时指针有值时是 in_progress', () => {
    expect(deriveEnrollmentStatus({ completedAt: null, currentLessonId: 'lesson_cuid_2' })).toBe('in_progress');
  });

  it('两者都为空时是 not_started（从没学过，或刚 restart）', () => {
    expect(deriveEnrollmentStatus({ completedAt: null, currentLessonId: null })).toBe('not_started');
  });
});

describe('computeProgressPercent', () => {
  it('没有 currentLessonId 时是 0', () => {
    expect(computeProgressPercent({ progress: null, modules: [{ lessons: [{ id: 'l1' }, { id: 'l2' }] }] })).toBe(0);
  });

  it('走到第二课（共 4 课）算出 50', () => {
    expect(computeProgressPercent({ progress: { currentLessonId: 'l2' }, modules: FOUR_LESSONS })).toBe(50);
  });
});

// status 和 progressPercent 是同一个事实的两种表达，所有返回报名信息的出口都必须经过 deriveEnrollmentView，
// 这张表就是它们共同遵守的不变量：completed ⇒ 100，not_started ⇒ 0，in_progress 介于两者之间。
describe('deriveEnrollmentView', () => {
  const cases: Array<{
    name: string;
    completedAt: Date | null;
    progress: { currentLessonId: string | null } | null;
    modules: typeof FOUR_LESSONS;
    expected: { status: string; progressPercent: number };
  }> = [
    { name: '没有 progress 行', completedAt: null, progress: null, modules: FOUR_LESSONS, expected: { status: 'not_started', progressPercent: 0 } },
    { name: '指针为空、未完成（刚 restart）', completedAt: null, progress: { currentLessonId: null }, modules: FOUR_LESSONS, expected: { status: 'not_started', progressPercent: 0 } },
    { name: '学到第二课', completedAt: null, progress: { currentLessonId: 'l2' }, modules: FOUR_LESSONS, expected: { status: 'in_progress', progressPercent: 50 } },
    { name: '已完成，指针为空', completedAt: new Date(), progress: { currentLessonId: null }, modules: FOUR_LESSONS, expected: { status: 'completed', progressPercent: 100 } },
    { name: '已完成后回看前面的课，指针回退', completedAt: new Date(), progress: { currentLessonId: 'l1' }, modules: FOUR_LESSONS, expected: { status: 'completed', progressPercent: 100 } },
    { name: '已完成，没有 progress 行', completedAt: new Date(), progress: null, modules: FOUR_LESSONS, expected: { status: 'completed', progressPercent: 100 } },
    { name: '没有课程内容时未完成算 0', completedAt: null, progress: { currentLessonId: 'l1' }, modules: [], expected: { status: 'in_progress', progressPercent: 0 } },
  ];

  it.each(cases)('$name', ({ completedAt, progress, modules, expected }) => {
    expect(deriveEnrollmentView({ completedAt, progress, modules })).toEqual(expected);
  });
});
