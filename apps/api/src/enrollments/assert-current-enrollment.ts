import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export class StaleEnrollmentError extends ConflictException {
  constructor() {
    super('课程已重新开始，请刷新后重试');
  }
}

// UPDATE 获取 Enrollment 行锁，并与 restart 的事务串行化。仅在同一事务内使用：
// 旧请求不能在校验通过后、写 Progress/Conversation 前被 restart 插入。
export async function assertCurrentEnrollment(
  tx: Prisma.TransactionClient,
  enrollmentId: string,
  generation: number,
): Promise<void> {
  const current = await tx.enrollment.updateMany({
    where: { id: enrollmentId, generation, active: true },
    data: { active: true },
  });
  if (current.count === 0) {
    throw new StaleEnrollmentError();
  }
}
