export type EnrollmentStatus = 'not_started' | 'in_progress' | 'completed';

type ProgressPointer = { currentLessonId: string | null } | null;
type ModulesWithLessons = Array<{ lessons: Array<{ id: string }> }>;

// 课程卡片按钮由这个状态决定，active 只表示“当前在学哪门”。
// 学完最后一课时课时指针会被清空，所以 completed 必须看 completedAt，不能只看指针。
export function deriveEnrollmentStatus(input: {
  completedAt: Date | null;
  currentLessonId: string | null;
}): EnrollmentStatus {
  if (input.completedAt) return 'completed';
  if (input.currentLessonId) return 'in_progress';
  return 'not_started';
}

export function computeProgressPercent(enrollment: { progress: ProgressPointer; modules: ModulesWithLessons }): number {
  const flattened = enrollment.modules.flatMap((courseModule) => courseModule.lessons);
  if (flattened.length === 0 || !enrollment.progress?.currentLessonId) {
    return 0;
  }
  const index = flattened.findIndex((lesson) => lesson.id === enrollment.progress!.currentLessonId);
  if (index === -1) return 0;
  return Math.round(((index + 1) / flattened.length) * 100);
}

// status 和 progressPercent 是同一个事实的两种表达。所有返回报名信息的出口都必须经过这里，
// 不要在别处单独算：学完后课时指针为空，按指针算出来是 0，所以已完成一律 100。
export function deriveEnrollmentView(input: {
  completedAt: Date | null;
  progress: ProgressPointer;
  modules: ModulesWithLessons;
}): { status: EnrollmentStatus; progressPercent: number } {
  const status = deriveEnrollmentStatus({
    completedAt: input.completedAt,
    currentLessonId: input.progress?.currentLessonId ?? null,
  });
  return {
    status,
    progressPercent: status === 'completed' ? 100 : computeProgressPercent(input),
  };
}
