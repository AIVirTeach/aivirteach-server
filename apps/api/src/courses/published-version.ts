import type { Prisma } from '@prisma/client';

/** Include only the newest version that has actually been published. */
export const LATEST_PUBLISHED_VERSION = {
  where: { publishedAt: { not: null } },
  orderBy: { version: 'desc' },
  take: 1,
  include: {
    modules: {
      orderBy: { position: 'asc' },
      include: {
        // 版本树只用于标题、顺序、进度；正文 body/content 单课读取时再单独取。
        lessons: {
          orderBy: { position: 'asc' },
          omit: { body: true, content: true },
        },
      },
    },
    welcome: true,
  },
} satisfies Prisma.Course$versionsArgs;
