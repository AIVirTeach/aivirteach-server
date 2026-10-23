import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, WorkspaceStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { assertCurrentEnrollment } from './assert-current-enrollment';
import {
  completedLessonIds,
  deriveCurrentModuleTitle,
  deriveEnrollmentView,
  type EnrollmentStatus,
} from './learning-progress-view';
import { LATEST_PUBLISHED_VERSION } from '../courses/published-version';
import { TOKEN_WEIGHTS } from '../token-usage/application/check-token-quota';
import {
  weightedConsumption,
  type TokenWeights,
} from '../token-usage/domain/token-weights';

export type EnrollmentResponse = {
  id: string;
  userId: string;
  courseId: string;
  active: boolean;
  progressPercent: number;
  status: EnrollmentStatus;
  currentModule: string;
  enrolledAt: string;
  workspaceResetPending?: boolean;
};

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coursesService: CoursesService,
    private readonly workspaceService: WorkspaceService,
    @Inject(TOKEN_WEIGHTS) private readonly tokenWeights: TokenWeights,
  ) {}

  async enroll(userId: string, slug: string): Promise<EnrollmentResponse> {
    const course =
      await this.coursesService.requirePublishedCourseWithLatestVersion(slug);
    const latestVersionId = course.versions[0].id;

    const enrollment = await this.prisma.$transaction(async (tx) => {
      await tx.enrollment.updateMany({
        where: { userId, active: true },
        data: { active: false },
      });

      return tx.enrollment.upsert({
        where: { userId_courseId: { userId, courseId: course.id } },
        update: { active: true, courseVersionId: latestVersionId },
        create: {
          userId,
          courseId: course.id,
          courseVersionId: latestVersionId,
          active: true,
        },
        include: { progress: true, lessonProgress: true },
      });
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.enroll',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });

    return this.toResponse(
      enrollment,
      course.slug,
      deriveEnrollmentView({
        generation: enrollment.generation,
        lessonProgress: enrollment.lessonProgress,
        active: enrollment.active,
        completedAt: enrollment.completedAt,
        progress: enrollment.progress,
        modules: course.versions[0].modules,
      }),
      deriveCurrentModuleTitle({
        progress: enrollment.progress,
        modules: course.versions[0].modules,
      }),
    );
  }

  async restart(userId: string, slug: string): Promise<EnrollmentResponse> {
    const course =
      await this.coursesService.requirePublishedCourseWithLatestVersion(slug);
    const latestVersionId = course.versions[0].id;

    const { enrollment, workspaceResetPending } =
      await this.prisma.$transaction(async (tx) => {
        await tx.enrollment.updateMany({
          where: { userId, active: true },
          data: { active: false },
        });

        const upserted = await tx.enrollment.upsert({
          where: { userId_courseId: { userId, courseId: course.id } },
          update: {
            active: false,
            generation: { increment: 1 },
            progressRevision: 0,
            courseVersionId: latestVersionId,
            completedAt: null,
          },
          create: {
            userId,
            courseId: course.id,
            courseVersionId: latestVersionId,
            active: false,
          },
        });

        await tx.progress.upsert({
          where: { enrollmentId: upserted.id },
          update: { currentLessonId: null, currentLessonContentId: null },
          create: {
            enrollmentId: upserted.id,
            currentLessonId: null,
            currentLessonContentId: null,
          },
        });

        // 全新 restart：清空聊天记录和 Learning Lab，让用户像第一次报名一样重新走一遍。
        // 保留 Attempt/EnrollmentCompletion（评测与结课审计记录），不清空。
        // token 消耗只存在 Conversation 的列上，删之前必须先结算成负的额度流水，
        // 否则学生额度用尽后点 restart 就能把消耗清零、无限续杯。
        const { _sum } = await tx.conversation.aggregate({
          where: { enrollmentId: upserted.id },
          _sum: {
            inputCacheHitTokens: true,
            inputCacheMissTokens: true,
            outputTokens: true,
          },
        });
        const consumed = weightedConsumption(
          {
            inputCacheHitTokens: _sum.inputCacheHitTokens ?? 0,
            inputCacheMissTokens: _sum.inputCacheMissTokens ?? 0,
            outputTokens: _sum.outputTokens ?? 0,
          },
          this.tokenWeights,
        );
        if (consumed > 0) {
          await tx.quotaLedger.create({
            data: { userId, tokensDelta: -consumed },
          });
        }
        await tx.conversation.deleteMany({
          where: { enrollmentId: upserted.id },
        });
        // 先把旧 workspace 标为待清理，保留 labId 供 Labs 删除失败后重试。
        const reset = await tx.workspace.updateMany({
          where: { enrollmentId: upserted.id },
          data: { status: WorkspaceStatus.RESETTING, resetRetryAt: null },
        });

        return { enrollment: upserted, workspaceResetPending: reset.count > 0 };
      });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.restart',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });

    // 事务提交后才调用 Labs；失败时 RESETTING 行仍在，维护扫描会继续重试。
    let pending = workspaceResetPending;
    if (pending) {
      try {
        pending = !(await this.workspaceService.finishReset(enrollment.id));
      } catch {
        // workspace.reset 失败审计由 WorkspaceService 记录。
      }
    }

    // restart 刚把进度指针清空、completedAt 置空，所以一定是 not_started。
    return {
      ...this.toResponse(
        enrollment,
        course.slug,
        deriveEnrollmentView({
          active: false,
          completedAt: enrollment.completedAt,
          progress: null,
          modules: [],
        }),
        '',
      ),
      workspaceResetPending: pending,
    };
  }

  async listForUser(userId: string): Promise<EnrollmentResponse[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId },
      include: {
        course: { include: { versions: LATEST_PUBLISHED_VERSION } },
        progress: true,
        lessonProgress: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return enrollments.map((enrollment) =>
      this.toResponse(
        enrollment,
        enrollment.course.slug,
        deriveEnrollmentView({
          generation: enrollment.generation,
          lessonProgress: enrollment.lessonProgress,
          active: enrollment.active,
          completedAt: enrollment.completedAt,
          progress: enrollment.progress,
          modules: enrollment.course.versions[0]?.modules ?? [],
        }),
        deriveCurrentModuleTitle({
          progress: enrollment.progress,
          modules: enrollment.course.versions[0]?.modules ?? [],
        }),
      ),
    );
  }

  async getProgress(userId: string, slug: string) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { userId, course: { slug, published: true } },
      include: {
        course: { include: { versions: LATEST_PUBLISHED_VERSION } },
        progress: true,
        lessonProgress: true,
        completionHistory: { orderBy: { completedAt: 'asc' } },
      },
    });
    if (!enrollment || !enrollment.course.versions[0])
      throw new NotFoundException('找不到已报名课程');
    return this.progressSnapshot(enrollment);
  }

  private progressSnapshot(enrollment: ProgressEnrollment) {
    const version = enrollment.course.versions[0];
    const input = { ...enrollment, modules: version.modules };
    const completedIds = completedLessonIds(input);
    const ids = version.modules.flatMap((m) =>
      m.lessons.map((l) => l.contentId),
    );
    const currentLessonId = ids.includes(
      enrollment.progress?.currentLessonContentId ?? '',
    )
      ? enrollment.progress!.currentLessonContentId
      : null;
    return {
      enrollmentId: enrollment.id,
      courseId: enrollment.course.slug,
      generation: enrollment.generation,
      revision: enrollment.progressRevision,
      courseVersionId: version.id,
      courseVersion: version.version,
      active: enrollment.active,
      completedLessonIds: completedIds,
      totalLessons: ids.length,
      currentLessonId,
      nextLessonId: ids.find((id) => !completedIds.includes(id)) ?? null,
      ...deriveEnrollmentView(input),
      achievements: enrollment.completionHistory.map((row) => ({
        generation: row.generation,
        completedAt: row.completedAt.toISOString(),
      })),
    };
  }

  async setLessonProgress(
    userId: string,
    slug: string,
    lessonId: string,
    command: CompletionCommand,
  ) {
    return this.writeProgress(userId, slug, lessonId, command);
  }

  async setReadingPosition(
    userId: string,
    slug: string,
    command: ReadingCommand,
  ) {
    return this.writeProgress(userId, slug, command.lessonId, command);
  }

  private async writeProgress(
    userId: string,
    slug: string,
    lessonId: string,
    command: CompletionCommand | ReadingCommand,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize with publication before reading the latest syllabus.
      const courses = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Course" WHERE slug = ${slug} AND published = true FOR SHARE`;
      if (!courses[0]) throw new NotFoundException('找不到课程');
      const owned = await tx.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: courses[0].id } },
      });
      if (!owned) throw new NotFoundException('找不到已报名课程');
      await assertCurrentEnrollment(tx, owned.id, command.generation);
      const enrollment = await tx.enrollment.findUniqueOrThrow({
        where: { id: owned.id },
        include: {
          course: { include: { versions: LATEST_PUBLISHED_VERSION } },
          progress: true,
          lessonProgress: true,
          completionHistory: true,
        },
      });
      const version = enrollment.course.versions[0];
      if (!version || version.id !== command.courseVersionId)
        throw new ConflictException('课程已更新，请刷新后重试');
      const lessons = version.modules.flatMap((m) => m.lessons);
      const matches = lessons.filter((l) => l.contentId === lessonId);
      if (matches.length !== 1) throw new NotFoundException('找不到唯一课时');
      if ('completed' in command) {
        const previous = enrollment.lessonProgress.find(
          (row) =>
            row.generation === command.generation && row.contentId === lessonId,
        );
        const alreadyCompleted = !!previous?.completedAt;
        // Identical retries do not duplicate revision, activities or achievements.
        if (alreadyCompleted === command.completed)
          return this.progressSnapshot(enrollment);
        if (enrollment.progressRevision !== command.revision)
          throw new ConflictException('学习进度已更新，请刷新后重试');
        const now = new Date();
        const record = await tx.lessonProgress.upsert({
          where: {
            enrollmentId_generation_contentId: {
              enrollmentId: enrollment.id,
              generation: command.generation,
              contentId: lessonId,
            },
          },
          create: {
            enrollmentId: enrollment.id,
            generation: command.generation,
            contentId: lessonId,
            completedAt: now,
            firstCompletedAt: now,
          },
          update: {
            completedAt: command.completed ? now : null,
            ...(command.completed && !previous?.firstCompletedAt
              ? { firstCompletedAt: now }
              : {}),
          },
        });
        enrollment.lessonProgress = enrollment.lessonProgress
          .filter(
            (row) =>
              !(
                row.generation === command.generation &&
                row.contentId === lessonId
              ),
          )
          .concat(record);
        if (command.completed && !previous?.firstCompletedAt)
          await tx.activity.create({
            data: {
              userId,
              enrollmentId: enrollment.id,
              kind: 'LESSON',
              title: matches[0].title,
              detail: `完成课时：${matches[0].title}`,
            },
          });
        const allComplete =
          completedLessonIds({ ...enrollment, modules: version.modules })
            .length === lessons.length;
        const completedAt =
          enrollment.completedAt ?? (allComplete ? now : null);
        const updated = await tx.enrollment.update({
          where: { id: enrollment.id },
          data: { progressRevision: { increment: 1 }, completedAt },
        });
        enrollment.progressRevision = updated.progressRevision;
        enrollment.completedAt = updated.completedAt;
        if (allComplete) {
          const achievement = await tx.courseCompletionHistory.upsert({
            where: {
              enrollmentId_generation: {
                enrollmentId: enrollment.id,
                generation: command.generation,
              },
            },
            create: {
              enrollmentId: enrollment.id,
              generation: command.generation,
              completedAt: completedAt!,
            },
            update: {},
          });
          enrollment.completionHistory = enrollment.completionHistory
            .filter((row) => row.generation !== command.generation)
            .concat(achievement);
        }
      } else {
        enrollment.progress = await tx.progress.upsert({
          where: { enrollmentId: enrollment.id },
          create: {
            enrollmentId: enrollment.id,
            currentLessonContentId: lessonId,
          },
          update: { currentLessonId: null, currentLessonContentId: lessonId },
        });
      }
      return this.progressSnapshot(enrollment);
    });
  }

  private toResponse(
    enrollment: {
      id: string;
      userId: string;
      courseId: string;
      active: boolean;
      createdAt: Date;
    },
    courseSlug: string,
    view: { status: EnrollmentStatus; progressPercent: number },
    currentModule = '',
  ): EnrollmentResponse {
    return {
      id: enrollment.id,
      userId: enrollment.userId,
      courseId: courseSlug,
      active: enrollment.active,
      progressPercent: view.progressPercent,
      status: view.status,
      currentModule,
      enrolledAt: enrollment.createdAt.toISOString(),
    };
  }
}

export type CompletionCommand = {
  generation: number;
  revision: number;
  courseVersionId: string;
  completed: boolean;
};
export type ReadingCommand = {
  generation: number;
  courseVersionId: string;
  lessonId: string;
};
type ProgressEnrollment = Prisma.EnrollmentGetPayload<{
  include: {
    course: { include: { versions: typeof LATEST_PUBLISHED_VERSION } };
    progress: true;
    lessonProgress: true;
    completionHistory: true;
  };
}>;
