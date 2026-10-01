import type { Prisma } from '@prisma/client';

/** Include only the newest version that has actually been published. */
export const LATEST_PUBLISHED_VERSION = {
  where: { publishedAt: { not: null } },
  orderBy: { version: 'desc' },
  take: 1,
  include: {
    modules: {
      orderBy: { position: 'asc' },
      include: { lessons: { orderBy: { position: 'asc' } } },
    },
    welcome: true,
  },
} satisfies Prisma.Course$versionsArgs;
