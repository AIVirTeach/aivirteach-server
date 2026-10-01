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
