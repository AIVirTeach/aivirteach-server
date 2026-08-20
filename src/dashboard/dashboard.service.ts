import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

type EnrollmentWithVersion = {
  progress: { currentLessonId: string | null } | null;
  modules: Array<{ lessons: Array<{ id: string }> }>;
};

export function computeProgressPercent(enrollment: EnrollmentWithVersion): number {
  const flattened = enrollment.modules.flatMap((courseModule) => courseModule.lessons);
  if (flattened.length === 0 || !enrollment.progress?.currentLessonId) {
    return 0;
  }
  const index = flattened.findIndex((lesson) => lesson.id === enrollment.progress!.currentLessonId);
  if (index === -1) return 0;
  return Math.round(((index + 1) / flattened.length) * 100);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type DashboardResponse = {
  learner: {
    id: string;
    name: string;
    email: string;
    role: string;
    plan: 'Free' | 'Premium';
    level: number;
    timezone: string;
    joinedAt: string;
    streakDays: number;
    skillsMastered: number;
    tasksCompleted: number;
  };
  activeCourse: null | {
    id: string;
    title: string;
    category: string;
    description: string;
    level: string;
    durationMinutes: number;
    lessonCount: number;
    published: boolean;
    coverAssetId: string | null;
    enrollment: {
      id: string;
      userId: string;
      courseId: string;
      active: boolean;
      progressPercent: number;
      currentModule: string;
      enrolledAt: string;
    };
  };
  progress: {
    userId: string;
    streakDays: number;
    skillsMastered: number;
    tasksCompleted: number;
    totalPracticeMinutes: number;
    weeklyHours: number[];
  };
  unreadNotificationCount: number;
  recentActivity: Array<{ id: string; title: string; detail: string; kind: string; occurredAt: string }>;
};

const LEVEL_TO_CLIENT: Record<string, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
};

const KIND_TO_CLIENT: Record<string, string> = {
  LESSON: 'lesson',
  PRACTICE: 'practice',
  ACHIEVEMENT: 'achievement',
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(userId: string): Promise<DashboardResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const activeEnrollment = await this.prisma.enrollment.findFirst({
      where: { userId, active: true },
      include: {
        course: true,
        progress: true,
        courseVersion: { include: { modules: { include: { lessons: true } } } },
      },
    });

    const [streakDays, tasksCompleted, totalPracticeMinutes, weeklyHours, unreadNotificationCount, recentActivity] =
      await Promise.all([
        this.computeStreakDays(userId),
        this.prisma.attempt.count({ where: { status: 'PASS', enrollment: { userId } } }),
        this.sumPracticeMinutes(userId),
        this.computeWeeklyHours(userId),
        this.prisma.notification.count({ where: { userId, readAt: null } }),
        this.prisma.activity.findMany({
          where: { userId },
          orderBy: { occurredAt: 'desc' },
          take: 10,
        }),
      ]);

    return {
      learner: {
        id: user.id,
        name: user.displayName ?? user.email,
        email: user.email,
        role: user.role,
        plan: user.plan === 'PREMIUM' ? 'Premium' : 'Free',
        level: user.level,
        timezone: user.timezone,
        joinedAt: user.createdAt.toISOString(),
        streakDays,
        skillsMastered: 0,
        tasksCompleted,
      },
      activeCourse: activeEnrollment
        ? {
            id: activeEnrollment.course.slug,
            title: activeEnrollment.course.title,
            category: activeEnrollment.course.category,
            description: activeEnrollment.course.description,
            level: LEVEL_TO_CLIENT[activeEnrollment.course.level] ?? activeEnrollment.course.level,
            durationMinutes: activeEnrollment.course.durationMinutes,
            lessonCount: activeEnrollment.course.lessonCount,
            published: activeEnrollment.course.published,
            coverAssetId: activeEnrollment.course.coverAssetId,
            enrollment: {
              id: activeEnrollment.id,
              userId: activeEnrollment.userId,
              courseId: activeEnrollment.course.slug,
              active: activeEnrollment.active,
              progressPercent: activeEnrollment.courseVersion
                ? computeProgressPercent({
                    progress: activeEnrollment.progress,
                    modules: activeEnrollment.courseVersion.modules,
                  })
                : 0,
              currentModule: '',
              enrolledAt: activeEnrollment.createdAt.toISOString(),
            },
          }
        : null,
      progress: {
        userId,
        streakDays,
        skillsMastered: 0,
        tasksCompleted,
        totalPracticeMinutes,
        weeklyHours,
      },
      unreadNotificationCount,
      recentActivity: recentActivity.map((activity) => ({
        id: activity.id,
        title: activity.title,
        detail: activity.detail,
        kind: KIND_TO_CLIENT[activity.kind] ?? activity.kind.toLowerCase(),
        occurredAt: activity.occurredAt.toISOString(),
      })),
    };
  }

  async listNotifications(userId: string) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return notifications.map((notification) => ({
      id: notification.id,
      message: notification.message,
      createdAt: notification.createdAt.toISOString(),
      readAt: notification.readAt?.toISOString() ?? null,
    }));
  }

  async markAllNotificationsRead(userId: string) {
    const readAt = new Date();
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt },
    });
    return { updated: result.count, readAt: readAt.toISOString() };
  }

  async recordPractice(userId: string, minutes: number): Promise<void> {
    await this.prisma.practiceSession.create({ data: { userId, minutes } });
  }

  private async computeStreakDays(userId: string): Promise<number> {
    const activities = await this.prisma.activity.findMany({
      where: { userId },
      select: { occurredAt: true },
      orderBy: { occurredAt: 'desc' },
    });
    const days = [...new Set(activities.map((activity) => dayKey(activity.occurredAt)))].sort().reverse();
    if (days.length === 0) return 0;

    let streak = 1;
    let cursor = new Date(days[0]);
    for (let i = 1; i < days.length; i++) {
      cursor = new Date(cursor.getTime() - DAY_MS);
      if (dayKey(cursor) !== days[i]) break;
      streak++;
    }
    return streak;
  }

  private async sumPracticeMinutes(userId: string): Promise<number> {
    const result = await this.prisma.practiceSession.aggregate({
      where: { userId },
      _sum: { minutes: true },
    });
    return result._sum.minutes ?? 0;
  }

  private async computeWeeklyHours(userId: string): Promise<number[]> {
    const since = new Date(Date.now() - 6 * DAY_MS);
    since.setUTCHours(0, 0, 0, 0);

    const sessions = await this.prisma.practiceSession.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { minutes: true, createdAt: true },
    });

    const minutesByDay = new Map<string, number>();
    for (const session of sessions) {
      const key = dayKey(session.createdAt);
      minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + session.minutes);
    }

    const hours: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * DAY_MS));
      hours.push(Math.round(((minutesByDay.get(key) ?? 0) / 60) * 100) / 100);
    }
    return hours;
  }
}
