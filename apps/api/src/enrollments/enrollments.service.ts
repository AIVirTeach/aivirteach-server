import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  LearningSnapshotReason,
  WorkspaceStatus,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { LATEST_PUBLISHED_VERSION } from '../courses/published-version';
import { TOKEN_WEIGHTS } from '../token-usage/application/check-token-quota';
import {
  weightedConsumption,
  type TokenWeights,
} from '../token-usage/domain/token-weights';
import {
  completedLessonIds,
  computeProgressPercent,
  deriveCurrentModuleTitle,
  deriveEnrollmentView,
  type EnrollmentStatus,
} from './learning-progress-view';
import {
  EMPTY_LEARNING_STATE,
  parseLearningState,
  remapReadingPosition,
  setLessonCompletion,
  setReadingPosition,
  withCourseCompletion,
  type LearningState,
} from './learning-state';

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
type ProjectionEnrollment = {
  id: string;
  userId: string;
  courseId: string;
  courseVersionId: string | null;
  generation: number;
  progressRevision: number;
  active: boolean;
  createdAt: Date;
  learningState: unknown;
};
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
export type RestartCommand = {
  requestId: string;
  generation: number;
  revision: number;
  courseVersionId: string;
};
export type SnapshotCommand = RestartCommand;

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
    const version = course.versions[0];
    const enrollment = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
      await tx.enrollment.updateMany({
        where: { userId, active: true },
        data: { active: false },
      });
      return tx.enrollment.upsert({
        where: { userId_courseId: { userId, courseId: course.id } },
        update: { active: true, courseVersionId: version.id },
        create: {
          userId,
          courseId: course.id,
          courseVersionId: version.id,
          active: true,
        },
      });
    });
    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.enroll',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });
    return this.toResponse(enrollment, course.slug, {
      learningState: parseLearningState(enrollment.learningState),
      modules: version.modules,
      active: true,
    });
  }

  async restart(
    userId: string,
    slug: string,
    command: RestartCommand,
  ): Promise<EnrollmentResponse> {
    const course =
      await this.coursesService.requirePublishedCourseWithLatestVersion(slug);
    const key = `restart:${command.requestId}`;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
      const lockedCourse = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Course" WHERE id = ${course.id} AND published = true FOR SHARE`;
      if (!lockedCourse[0])
        throw new ConflictException('课程已更新，请刷新后重试');
      const liveCourse = await tx.course.findFirst({
        where: { id: course.id, published: true },
        include: { versions: LATEST_PUBLISHED_VERSION },
      });
      const version = liveCourse?.versions[0];
      if (!version) throw new ConflictException('课程已更新，请刷新后重试');
      const owned = await tx.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: course.id } },
      });
      if (!owned) throw new NotFoundException('找不到已报名课程');
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${owned.id} FOR UPDATE`;
      const existing = await tx.learningSnapshot.findUnique({
        where: {
          enrollmentId_idempotencyKey: {
            enrollmentId: owned.id,
            idempotencyKey: key,
          },
        },
      });
      const current = await tx.enrollment.findUniqueOrThrow({
        where: { id: owned.id },
      });
      if (existing) {
        if (
          existing.sourceGeneration !== command.generation ||
          existing.sourceRevision !== command.revision ||
          existing.courseVersionId !== command.courseVersionId
        )
          throw new ConflictException('requestId 已用于不同的重启命令');
        const workspace = await tx.workspace.findUnique({
          where: { enrollmentId: owned.id },
        });
        return {
          enrollment: current,
          version,
          pending: workspace?.status === WorkspaceStatus.RESETTING,
          replay: true,
        };
      }
      if (
        current.generation !== command.generation ||
        current.progressRevision !== command.revision ||
        version.id !== command.courseVersionId
      )
        throw new ConflictException('学习进度已更新，请刷新后重试');
      const state = parseLearningState(current.learningState);
      await tx.learningSnapshot.create({
        data: {
          enrollmentId: current.id,
          sourceGeneration: current.generation,
          sourceRevision: current.progressRevision,
          courseVersionId: version.id,
          schemaVersion: 1,
          state: state,
          reason: LearningSnapshotReason.RESTART,
          idempotencyKey: key,
        },
      });
      await tx.enrollment.updateMany({
        where: { userId, active: true },
        data: { active: false },
      });
      const updated = await tx.enrollment.update({
        where: { id: current.id },
        data: {
          active: false,
          generation: { increment: 1 },
          progressRevision: 0,
          courseVersionId: version.id,
          learningState: EMPTY_LEARNING_STATE,
        },
      });
      const { _sum } = await tx.conversation.aggregate({
        where: { enrollmentId: updated.id },
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
      if (consumed > 0)
        await tx.quotaLedger.create({
          data: { userId, tokensDelta: -consumed },
        });
      await tx.conversation.deleteMany({ where: { enrollmentId: updated.id } });
      const reset = await tx.workspace.updateMany({
        where: { enrollmentId: updated.id },
        data: { status: WorkspaceStatus.RESETTING, resetRetryAt: null },
      });
      return {
        enrollment: updated,
        version,
        pending: reset.count > 0,
        replay: false,
      };
    });
    if (!result.replay)
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'enrollment.restart',
        success: true,
        targetType: 'Enrollment',
        targetId: result.enrollment.id,
      });
    let pending = result.pending;
    if (pending) {
      try {
        pending = !(await this.workspaceService.finishReset(
          result.enrollment.id,
        ));
      } catch {
        pending = true;
      }
    }
    return {
      ...this.toResponse(result.enrollment, course.slug, {
        learningState: parseLearningState(result.enrollment.learningState),
        modules: result.version.modules,
        active: result.enrollment.active,
      }),
      workspaceResetPending: pending,
    };
  }

  async listForUser(userId: string): Promise<EnrollmentResponse[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId },
      include: { course: { include: { versions: LATEST_PUBLISHED_VERSION } } },
      orderBy: { createdAt: 'asc' },
    });
    return enrollments.map((row) =>
      this.toResponse(row, row.course.slug, {
        learningState: parseLearningState(row.learningState),
        modules: row.course.versions[0]?.modules ?? [],
        active: row.active,
      }),
    );
  }

  async getProgress(userId: string, slug: string) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { userId, course: { slug, published: true } },
      include: {
        course: { include: { versions: LATEST_PUBLISHED_VERSION } },
        snapshots: {
          where: {
            reason: {
              in: [
                LearningSnapshotReason.COMPLETED,
                LearningSnapshotReason.LEGACY_ACHIEVEMENT,
              ],
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!enrollment || !enrollment.course.versions[0])
      throw new NotFoundException('找不到已报名课程');
    const version = enrollment.course.versions[0];
    const state = parseLearningState(enrollment.learningState);
    return {
      ...this.progressSnapshot(
        enrollment,
        state,
        version,
        enrollment.course.slug,
        enrollment.snapshots,
      ),
      courseVersion: version.version,
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
      const courses = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Course" WHERE slug = ${slug} AND published = true FOR SHARE`;
      if (!courses[0]) throw new NotFoundException('找不到课程');
      const owned = await tx.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: courses[0].id } },
      });
      if (!owned) throw new NotFoundException('找不到已报名课程');
      const fence = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Enrollment" WHERE id = ${owned.id} AND generation = ${command.generation} AND active = true FOR UPDATE`;
      if (!fence[0])
        throw new ConflictException('课程已重新开始，请刷新后重试');
      const enrollment = await tx.enrollment.findUniqueOrThrow({
        where: { id: owned.id },
        include: {
          course: { include: { versions: LATEST_PUBLISHED_VERSION } },
          snapshots: {
            where: {
              reason: {
                in: [
                  LearningSnapshotReason.COMPLETED,
                  LearningSnapshotReason.LEGACY_ACHIEVEMENT,
                ],
              },
            },
          },
        },
      });
      const version = enrollment.course.versions[0];
      if (!version || version.id !== command.courseVersionId)
        throw new ConflictException('课程已更新，请刷新后重试');
      const matches = version.modules
        .flatMap((m) => m.lessons)
        .filter((l) => l.contentId === lessonId);
      if (matches.length !== 1) throw new NotFoundException('找不到唯一课时');
      const state = parseLearningState(enrollment.learningState);
      if ('completed' in command) {
        const previous = state.lessons[lessonId];
        const alreadyCompleted = !!previous?.completedAt;
        if (alreadyCompleted === command.completed)
          return this.progressSnapshot(
            enrollment,
            state,
            version,
            enrollment.course.slug,
            enrollment.snapshots,
          );
        if (enrollment.progressRevision !== command.revision)
          throw new ConflictException('学习进度已更新，请刷新后重试');
        const now = new Date();
        let next = setLessonCompletion(state, lessonId, command.completed, now);
        const uniqueLessonIds = new Set(
          version.modules.flatMap((m) => m.lessons.map((l) => l.contentId)),
        );
        const done = [...uniqueLessonIds].every(
          (id) => next.lessons[id]?.completedAt,
        );
        if (done && !next.completedAt)
          next = withCourseCompletion(next, now.toISOString());
        const updated = await tx.enrollment.update({
          where: { id: enrollment.id },
          data: {
            learningState: next,
            progressRevision: { increment: 1 },
          },
        });
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
        if (done && !state.completedAt) {
          await tx.learningSnapshot.create({
            data: {
              enrollmentId: enrollment.id,
              sourceGeneration: command.generation,
              sourceRevision: updated.progressRevision,
              courseVersionId: version.id,
              schemaVersion: 1,
              state: next,
              reason: LearningSnapshotReason.COMPLETED,
              idempotencyKey: `completed:${command.generation}`,
            },
          });
        }
        return this.progressSnapshot(
          {
            ...enrollment,
            progressRevision: updated.progressRevision,
            learningState: next,
          },
          next,
          version,
          enrollment.course.slug,
          enrollment.snapshots,
        );
      }
      const next = setReadingPosition(state, lessonId);
      if (next.readingLessonId !== state.readingLessonId) {
        const updated = await tx.enrollment.update({
          where: { id: enrollment.id },
          data: {
            learningState: next,
            progressRevision: { increment: 1 },
          },
        });
        enrollment.progressRevision = updated.progressRevision;
        enrollment.learningState = next;
      }
      return this.progressSnapshot(
        enrollment,
        next,
        version,
        enrollment.course.slug,
        enrollment.snapshots,
      );
    });
  }

  private progressSnapshot(
    enrollment: ProjectionEnrollment,
    state: LearningState,
    version: {
      id: string;
      version: number;
      modules: Array<{ title: string; lessons: Array<{ contentId: string }> }>;
    },
    courseSlug: string,
    snapshots: Array<{
      sourceGeneration: number;
      createdAt: Date;
      state: Prisma.JsonValue;
    }> = [],
  ) {
    const input = {
      learningState: state,
      modules: version.modules,
      active: enrollment.active,
    };
    const ids = version.modules.flatMap((m) =>
      m.lessons.map((l) => l.contentId),
    );
    const completed = completedLessonIds(input);
    const achievements = snapshots.map((row) => ({
      generation: row.sourceGeneration,
      completedAt:
        (row.state as { completedAt?: string | null }).completedAt ??
        row.createdAt.toISOString(),
    }));
    if (
      state.completedAt &&
      !achievements.some((row) => row.generation === enrollment.generation)
    )
      achievements.push({
        generation: enrollment.generation,
        completedAt: state.completedAt,
      });
    return {
      enrollmentId: enrollment.id,
      courseId: courseSlug,
      generation: enrollment.generation,
      revision: enrollment.progressRevision,
      courseVersionId: version.id,
      courseVersion: version.version,
      active: enrollment.active,
      completedLessonIds: completed,
      totalLessons: ids.length,
      currentLessonId: ids.includes(state.readingLessonId ?? '')
        ? state.readingLessonId
        : null,
      nextLessonId: ids.find((id) => !completed.includes(id)) ?? null,
      ...deriveEnrollmentView(input),
      achievements,
    };
  }

  async createSnapshot(userId: string, slug: string, command: SnapshotCommand) {
    const course =
      await this.coursesService.requirePublishedCourseWithLatestVersion(slug);
    return this.prisma.$transaction(async (tx) => {
      const lockedCourse = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Course" WHERE id = ${course.id} AND published = true FOR SHARE`;
      if (!lockedCourse[0])
        throw new ConflictException('课程已更新，请刷新后重试');
      const liveCourse = await tx.course.findFirst({
        where: { id: course.id, published: true },
        include: { versions: LATEST_PUBLISHED_VERSION },
      });
      const version = liveCourse?.versions[0];
      if (!version) throw new ConflictException('课程已更新，请刷新后重试');
      const owned = await tx.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: course.id } },
      });
      if (!owned) throw new NotFoundException('找不到已报名课程');
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${owned.id} FOR UPDATE`;
      const current = await tx.enrollment.findUniqueOrThrow({
        where: { id: owned.id },
      });
      const key = `manual:${command.requestId}`;
      const existing = await tx.learningSnapshot.findUnique({
        where: {
          enrollmentId_idempotencyKey: {
            enrollmentId: current.id,
            idempotencyKey: key,
          },
        },
      });
      if (existing) {
        if (
          existing.sourceGeneration !== command.generation ||
          existing.sourceRevision !== command.revision ||
          existing.courseVersionId !== command.courseVersionId
        )
          throw new ConflictException('requestId 已用于不同的快照命令');
        return existing;
      }
      if (
        current.generation !== command.generation ||
        current.progressRevision !== command.revision ||
        version.id !== command.courseVersionId
      )
        throw new ConflictException('学习进度或课程版本已更新，请刷新后重试');
      return tx.learningSnapshot.create({
        data: {
          enrollmentId: current.id,
          sourceGeneration: current.generation,
          sourceRevision: current.progressRevision,
          courseVersionId: version.id,
          schemaVersion: 1,
          state: parseLearningState(current.learningState),
          reason: LearningSnapshotReason.MANUAL,
          idempotencyKey: key,
        },
      });
    });
  }

  async listSnapshots(userId: string, slug: string, cursor?: string) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { userId, course: { slug } },
    });
    if (!enrollment) throw new NotFoundException('找不到已报名课程');
    const rows = await this.prisma.learningSnapshot.findMany({
      where: { enrollmentId: enrollment.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        courseVersion: {
          select: {
            version: true,
            modules: {
              orderBy: { position: 'asc' },
              select: {
                title: true,
                lessons: {
                  orderBy: { position: 'asc' },
                  select: { contentId: true, title: true },
                },
              },
            },
          },
        },
      },
    });
    const hasMore = rows.length > 50;
    const page = rows.slice(0, 50);
    const items = page.map(({ state: json, ...row }) => {
      if (row.schemaVersion !== 1 || !row.courseVersion)
        return {
          ...row,
          completeStateAvailable: false,
          completedLessonCount: null,
          totalLessons: null,
          progressPercent: null,
        };
      const state = parseLearningState(json);
      const input = {
        learningState: state,
        modules: row.courseVersion.modules,
        active: false,
      };
      const totalLessons = new Set(
        row.courseVersion.modules.flatMap((module) =>
          module.lessons.map((lesson) => lesson.contentId),
        ),
      ).size;
      return {
        ...row,
        completeStateAvailable: true,
        completedLessonCount: completedLessonIds(input).length,
        totalLessons,
        progressPercent: computeProgressPercent(input),
      };
    });
    return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }
  async getSnapshot(userId: string, slug: string, snapshotId: string) {
    const snapshot = await this.prisma.learningSnapshot.findFirst({
      where: { id: snapshotId, enrollment: { userId, course: { slug } } },
      include: {
        courseVersion: {
          select: {
            version: true,
            modules: {
              orderBy: { position: 'asc' },
              select: {
                title: true,
                lessons: {
                  orderBy: { position: 'asc' },
                  select: { contentId: true, title: true },
                },
              },
            },
          },
        },
      },
    });
    if (!snapshot) throw new NotFoundException('找不到学习快照');
    return snapshot.schemaVersion === 1
      ? { ...snapshot, state: parseLearningState(snapshot.state) }
      : snapshot;
  }

  /** Called inside the publisher transaction; learning JSON remains owned here. */
  async remapPublishedReadingPointers(
    tx: Prisma.TransactionClient,
    courseId: string,
    removedToReplacement: ReadonlyMap<string, string>,
  ) {
    const enrollmentIds = await tx.enrollment.findMany({
      where: { courseId },
      select: { id: true },
    });
    for (const { id } of enrollmentIds) {
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.enrollment.findUniqueOrThrow({ where: { id } });
      const state = parseLearningState(current.learningState);
      const next = remapReadingPosition(state, removedToReplacement);
      if (next !== state)
        await tx.enrollment.update({
          where: { id },
          data: {
            learningState: next,
            progressRevision: { increment: 1 },
          },
        });
    }
  }

  private toResponse(
    enrollment: ProjectionEnrollment,
    courseSlug: string,
    input: {
      learningState: LearningState;
      modules: Array<{ title: string; lessons: Array<{ contentId: string }> }>;
      active: boolean;
    },
  ): EnrollmentResponse {
    const view = deriveEnrollmentView(input);
    return {
      id: enrollment.id,
      userId: enrollment.userId,
      courseId: courseSlug,
      active: enrollment.active,
      progressPercent: view.progressPercent,
      status: view.status,
      currentModule: deriveCurrentModuleTitle(input),
      enrolledAt: enrollment.createdAt.toISOString(),
    };
  }
}
