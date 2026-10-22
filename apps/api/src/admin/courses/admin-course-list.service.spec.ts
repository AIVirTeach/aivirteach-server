import { AdminCourseListService } from './admin-course-list.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('AdminCourseListService', () => {
  it('returns an empty list for an empty catalog', async () => {
    const prisma = {
      course: { findMany: jest.fn().mockResolvedValue([]) },
      courseModule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminCourseListService(
      prisma as unknown as PrismaService,
    );
    await expect(service.list()).resolves.toEqual([]);
  });

  it('aggregates all courses with a fixed number of queries and chooses draft lessons', async () => {
    const courses = Array.from({ length: 30 }, (_, index) => ({
      id: `course-${index}`,
      slug: `course-${index}`,
      title: `Course ${index}`,
      published: true,
      versions: [
        { id: `draft-${index}`, version: 2, publishedAt: null },
        { id: `published-${index}`, version: 1, publishedAt: new Date() },
      ],
      _count: { enrollments: index },
    }));
    const prisma = {
      course: { findMany: jest.fn().mockResolvedValue(courses) },
      courseModule: {
        findMany: jest.fn().mockResolvedValue(
          courses.flatMap((_, index) => [
            { courseVersionId: `draft-${index}`, _count: { lessons: 2 } },
            { courseVersionId: `draft-${index}`, _count: { lessons: 3 } },
          ]),
        ),
      },
    };
    const service = new AdminCourseListService(
      prisma as unknown as PrismaService,
    );
    const rows = await service.list();
    expect(rows).toHaveLength(30);
    expect(rows[29]).toMatchObject({
      hasDraft: true,
      latestPublishedVersion: 1,
      lessonCount: 5,
      activeEnrollments: 29,
    });
    expect(prisma.course.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.courseModule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.courseModule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          courseVersionId: { in: courses.map((_, index) => `draft-${index}`) },
        },
      }),
    );
  });
});
