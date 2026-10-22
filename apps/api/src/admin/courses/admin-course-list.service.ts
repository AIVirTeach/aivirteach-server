import { Injectable } from '@nestjs/common';
import type { CourseListItem } from '@aivirteach/admin-contract';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminCourseListService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<CourseListItem[]> {
    const courses = await this.prisma.course.findMany({
      orderBy: [{ title: 'asc' }, { slug: 'asc' }],
      select: {
        id: true,
        slug: true,
        title: true,
        published: true,
        versions: {
          orderBy: { version: 'desc' },
          select: { id: true, version: true, publishedAt: true },
        },
        _count: { select: { enrollments: { where: { active: true } } } },
      },
    });
    const selectedVersions = courses.map(
      (course) =>
        course.versions.find((version) => !version.publishedAt) ??
        course.versions[0],
    );
    const modules = await this.prisma.courseModule.findMany({
      where: {
        courseVersionId: {
          in: selectedVersions.flatMap((version) =>
            version ? [version.id] : [],
          ),
        },
      },
      select: { courseVersionId: true, _count: { select: { lessons: true } } },
    });
    const lessonCounts = new Map<string, number>();
    for (const module of modules) {
      lessonCounts.set(
        module.courseVersionId,
        (lessonCounts.get(module.courseVersionId) ?? 0) + module._count.lessons,
      );
    }
    return courses.map((course, index) => ({
      slug: course.slug,
      title: course.title,
      published: course.published,
      latestPublishedVersion:
        course.versions.find((version) => version.publishedAt)?.version ?? null,
      hasDraft: course.versions.some((version) => !version.publishedAt),
      lessonCount: lessonCounts.get(selectedVersions[index]?.id ?? '') ?? 0,
      activeEnrollments: course._count.enrollments,
    }));
  }
}
