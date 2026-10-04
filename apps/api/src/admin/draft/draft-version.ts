import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export const DRAFT_INCLUDE = {
  modules: {
    orderBy: { position: 'asc' },
    include: {
      lessons: {
        orderBy: { position: 'asc' },
        include: { assessments: true },
      },
    },
  },
  welcome: true,
} satisfies Prisma.CourseVersionInclude;

export type DraftVersion = Prisma.CourseVersionGetPayload<{
  include: typeof DRAFT_INCLUDE;
}>;

// 锁住这个草稿行（FOR UPDATE）：草稿写入和发版互斥，发版翻转之后不会再有写入落到已发布版本上。
// 返回 false 表示它已不是未发布的草稿（已被发布或已被丢弃）。
export async function lockUnpublishedVersion(
  tx: Prisma.TransactionClient,
  versionId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "CourseVersion"
    WHERE id = ${versionId} AND "publishedAt" IS NULL
    FOR UPDATE`;
  return rows.length > 0;
}

export async function requireUnpublishedVersion(
  tx: Prisma.TransactionClient,
  versionId: string,
): Promise<void> {
  if (!(await lockUnpublishedVersion(tx, versionId))) {
    throw new ConflictException('草稿已发布或已被丢弃，请刷新后重试');
  }
}
