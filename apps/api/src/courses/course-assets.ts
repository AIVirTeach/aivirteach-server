import type { PrismaService } from '../prisma/prisma.service';

export type CourseAssetResponseRow = {
  id: string;
  objectKey: string;
  altText: string | null;
};

/** Fetch only assets referenced by a lesson and owned by its course. */
export async function loadCourseAssets(
  prisma: Pick<PrismaService, 'courseAsset'>,
  courseId: string,
  ids: string[],
): Promise<CourseAssetResponseRow[]> {
  if (ids.length === 0) return [];

  return prisma.courseAsset.findMany({
    where: { courseId, id: { in: ids } },
  });
}
