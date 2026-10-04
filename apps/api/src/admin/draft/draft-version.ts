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

// 写接口的响应和事务内快照用：不带课时正文 body/content（每课最多 256 KB），
// 完整内容只由 GET draft 返回，自动保存才不会每次回传整门课。
export const DRAFT_SUMMARY_INCLUDE = {
  modules: {
    orderBy: { position: 'asc' },
    include: {
      lessons: {
        orderBy: { position: 'asc' },
        omit: { body: true, content: true },
        include: { assessments: true },
      },
    },
  },
  welcome: true,
} satisfies Prisma.CourseVersionInclude;

export type DraftSummary = Prisma.CourseVersionGetPayload<{
  include: typeof DRAFT_SUMMARY_INCLUDE;
}>;

// 批量写（深拷贝、重排、发版重映射）在远程库上可能超过 Prisma 默认的 5 秒。
export const DRAFT_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

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
