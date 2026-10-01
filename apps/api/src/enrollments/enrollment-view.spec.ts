import { computeProgressPercent, deriveCurrentModuleTitle, deriveEnrollmentStatus, deriveEnrollmentView } from './enrollment-view';

const FOUR_LESSONS = [
  { title: 'Module One', lessons: [{ contentId: 'l1' }, { contentId: 'l2' }] },
  { title: 'Module Two', lessons: [{ contentId: 'l3' }, { contentId: 'l4' }] },
];

describe('deriveEnrollmentStatus', () => {
  it('有 completedAt 时是 completed（学完最后一课后课时指针会被清空，不能只看指针）', () => {
    expect(deriveEnrollmentStatus({ completedAt: new Date(), currentLessonContentId: null })).toBe('completed');
  });

  it('没有 completedAt、课时指针有值时是 in_progress', () => {
    expect(deriveEnrollmentStatus({ completedAt: null, currentLessonContentId: 'lesson_cuid_2' })).toBe('in_progress');
  });

  it('两者都为空时是 not_started（从没学过，或刚 restart）', () => {
    expect(deriveEnrollmentStatus({ completedAt: null, currentLessonContentId: null })).toBe('not_started');
  });
});

describe('computeProgressPercent', () => {
  it('没有 currentLessonContentId 时是 0', () => {
    expect(computeProgressPercent({ progress: null, modules: [{ title: 'Module', lessons: [{ contentId: 'l1' }, { contentId: 'l2' }] }] })).toBe(0);
  });

  it('走到第二课（共 4 课）算出 50', () => {
    expect(computeProgressPercent({ progress: { currentLessonContentId: 'l2' }, modules: FOUR_LESSONS })).toBe(50);
  });
});

describe('deriveCurrentModuleTitle', () => {
  it('指针在第二个模块的课时上时返回第二个模块标题', () => {
    expect(deriveCurrentModuleTitle({ progress: { currentLessonContentId: 'l3' }, modules: FOUR_LESSONS })).toBe('Module Two');
  });

  it('指针为空时返回空标题', () => {
    expect(deriveCurrentModuleTitle({ progress: null, modules: FOUR_LESSONS })).toBe('');
  });

  it('指针不在任何模块时返回空标题', () => {
    expect(deriveCurrentModuleTitle({ progress: { currentLessonContentId: 'missing' }, modules: FOUR_LESSONS })).toBe('');
  });
});

// status 和 progressPercent 是同一个事实的两种表达，所有返回报名信息的出口都必须经过 deriveEnrollmentView，
// 这张表就是它们共同遵守的不变量：completed ⇒ 100，not_started ⇒ 0，in_progress 介于两者之间。
describe('deriveEnrollmentView', () => {
  const cases: Array<{
    name: string;
    completedAt: Date | null;
    progress: { currentLessonContentId: string | null } | null;
    modules: typeof FOUR_LESSONS;
    expected: { status: string; progressPercent: number };
  }> = [
    { name: '没有 progress 行', completedAt: null, progress: null, modules: FOUR_LESSONS, expected: { status: 'not_started', progressPercent: 0 } },
    { name: '指针为空、未完成（刚 restart）', completedAt: null, progress: { currentLessonContentId: null }, modules: FOUR_LESSONS, expected: { status: 'not_started', progressPercent: 0 } },
    { name: '学到第二课', completedAt: null, progress: { currentLessonContentId: 'l2' }, modules: FOUR_LESSONS, expected: { status: 'in_progress', progressPercent: 50 } },
    { name: '已完成，指针为空', completedAt: new Date(), progress: { currentLessonContentId: null }, modules: FOUR_LESSONS, expected: { status: 'completed', progressPercent: 100 } },
    { name: '已完成后回看前面的课，指针回退', completedAt: new Date(), progress: { currentLessonContentId: 'l1' }, modules: FOUR_LESSONS, expected: { status: 'completed', progressPercent: 100 } },
    { name: '已完成，没有 progress 行', completedAt: new Date(), progress: null, modules: FOUR_LESSONS, expected: { status: 'completed', progressPercent: 100 } },
    { name: '没有课程内容时未完成算 0', completedAt: null, progress: { currentLessonContentId: 'l1' }, modules: [], expected: { status: 'in_progress', progressPercent: 0 } },
  ];

  it.each(cases)('$name', ({ completedAt, progress, modules, expected }) => {
    expect(deriveEnrollmentView({ completedAt, progress, modules })).toEqual(expected);
  });
});
