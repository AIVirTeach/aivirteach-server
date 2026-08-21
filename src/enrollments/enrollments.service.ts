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

  async completeLesson(userId: string, lessonId: string): Promise<EnrollmentResponse> {
    // contentId 只在同一模块内唯一，不同课程会复用同一套课时命名（比如环境搭建步骤），
    // 所以不能像以前那样直接全局查 contentId——要先定位到用户当前在读的课程，
    // 再去这门课的版本里按 contentId 找课时。这跟 CoursesService.getLesson 的做法一致。
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { userId, active: true },
      include: {
        course: true,
        currentModule: true,
        courseVersion: {
          include: {
            modules: {
              orderBy: { position: 'asc' },
              include: { lessons: { orderBy: { position: 'asc' } } },
            },
          },
        },
      },
    });
    if (!enrollment || !enrollment.courseVersion) {
      throw new NotFoundException(`用户还没有报名任何课程`);
    }

    const flattened = enrollment.courseVersion.modules.flatMap(
      (courseModule) => courseModule.lessons,
    );
    const index = flattened.findIndex((entry) => entry.contentId === lessonId);
    if (index === -1) {
      throw new NotFoundException(`找不到课时：${lessonId}`);
    }
    const lesson = flattened[index];

    await this.prisma.activity.create({
      data: {
        userId,
        enrollmentId: enrollment.id,
        kind: 'LESSON',
        title: lesson.title,
        detail: `完成课时：${lesson.title}`,
      },
    });

    const nextLessonId = flattened[index + 1]?.id ?? null;

    await this.prisma.progress.upsert({
      where: { enrollmentId: enrollment.id },
      update: { currentLessonId: nextLessonId },
      create: { enrollmentId: enrollment.id, currentLessonId: nextLessonId },
    });

    const progressPercent = computeProgressPercent({
      progress: { currentLessonId: nextLessonId },
      modules: enrollment.courseVersion.modules,
    });

    return this.toResponse(enrollment, enrollment.course.slug, progressPercent);
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
