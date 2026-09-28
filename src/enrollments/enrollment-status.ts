export type EnrollmentStatus = 'not_started' | 'in_progress' | 'completed';

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
