import { deriveEnrollmentStatus } from './enrollment-status';

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
