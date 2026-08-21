import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { computeProgressPercent } from '../dashboard/dashboard.service';

export type EnrollmentResponse = {
  id: string;
  userId: string;
  courseId: string;
  active: boolean;
  progressPercent: number;
  currentModule: string;
  enrolledAt: string;
};

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coursesService: CoursesService,
  ) {}

  async enroll(userId: string, slug: string): Promise<EnrollmentResponse> {
    const course = await this.coursesService.requirePublishedCourseWithLatestVersion(slug);
    const latestVersionId = course.versions[0].id;

    const enrollment = await this.prisma.$transaction(async (tx) => {
      await tx.enrollment.updateMany({
        where: { userId, active: true },
        data: { active: false },
      });

      return tx.enrollment.upsert({
        where: { userId_courseId: { userId, courseId: course.id } },
        update: { active: true, courseVersionId: latestVersionId },
        create: { userId, courseId: course.id, courseVersionId: latestVersionId, active: true },
        include: { currentModule: true },
      });
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.enroll',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });

    return this.toResponse(enrollment, course.slug, 0);
  }

  async restart(userId: string, slug: string): Promise<EnrollmentResponse> {
    const course = await this.coursesService.requirePublishedCourseWithLatestVersion(slug);
    const latestVersionId = course.versions[0].id;

    const enrollment = await this.prisma.$transaction(async (tx) => {
      await tx.enrollment.updateMany({
        where: { userId, active: true },
        data: { active: false },
      });

      const upserted = await tx.enrollment.upsert({
        where: { userId_courseId: { userId, courseId: course.id } },
        update: { active: true, currentModuleId: null, courseVersionId: latestVersionId },
        create: { userId, courseId: course.id, courseVersionId: latestVersionId, active: true },
        include: { currentModule: true },
      });

      await tx.progress.upsert({
        where: { enrollmentId: upserted.id },
        update: { currentLessonId: null },
        create: { enrollmentId: upserted.id },
      });

      return upserted;
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.restart',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });

    return this.toResponse(enrollment, course.slug, 0);
  }

  async listForUser(userId: string): Promise<EnrollmentResponse[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId },
      include: {
        course: true,
        currentModule: true,
        progress: true,
        courseVersion: { include: { modules: { include: { lessons: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return enrollments.map((enrollment) =>
      this.toResponse(
        enrollment,
        enrollment.course.slug,
        enrollment.courseVersion
          ? computeProgressPercent({ progress: enrollment.progress, modules: enrollment.courseVersion.modules })
          : 0,
      ),
    );
  }

  async completeLesson(userId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.courseLesson.findUnique({
      where: { contentId: lessonId },
      include: {
        module: {
          include: {
            courseVersion: {
              include: {
                modules: {
                  orderBy: { position: 'asc' },
                  include: { lessons: { orderBy: { position: 'asc' } } },
                },
              },
            },
          },
        },
      },
    });
    if (!lesson) {
      throw new NotFoundException(`找不到课时：${lessonId}`);
    }

    const courseId = lesson.module.courseVersion.courseId;
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { userId, courseId },
    });
    if (!enrollment) {
      throw new NotFoundException(`用户还没有报名这门课`);
    }

    await this.prisma.activity.create({
      data: {
        userId,
        enrollmentId: enrollment.id,
        kind: 'LESSON',
        title: lesson.title,
        detail: `完成课时：${lesson.title}`,
      },
    });

    const flattened = lesson.module.courseVersion.modules.flatMap(
      (courseModule) => courseModule.lessons,
    );
    const index = flattened.findIndex((entry) => entry.id === lesson.id);
    const nextLessonId = flattened[index + 1]?.id ?? null;

    await this.prisma.progress.upsert({
      where: { enrollmentId: enrollment.id },
      update: { currentLessonId: nextLessonId },
      create: { enrollmentId: enrollment.id, currentLessonId: nextLessonId },
    });
  }

  private toResponse(
    enrollment: {
      id: string;
      userId: string;
      courseId: string;
      active: boolean;
      currentModule: { title: string } | null;
      createdAt: Date;
    },
    courseSlug: string,
    progressPercent: number,
  ): EnrollmentResponse {
    return {
      id: enrollment.id,
      userId: enrollment.userId,
      courseId: courseSlug,
      active: enrollment.active,
      progressPercent,
      currentModule: enrollment.currentModule?.title ?? '',
      enrolledAt: enrollment.createdAt.toISOString(),
    };
  }
}
