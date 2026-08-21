import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService, computeProgressPercent } from './dashboard.service';

const buildPrisma = () => ({
  user: { findUniqueOrThrow: jest.fn() },
  enrollment: { findFirst: jest.fn() },
  activity: { findMany: jest.fn().mockResolvedValue([]) },
  attempt: { count: jest.fn().mockResolvedValue(0) },
  practiceSession: {
    findMany: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue({ _sum: { minutes: 0 } }),
    create: jest.fn(),
  },
  notification: {
    findMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [DashboardService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(DashboardService);
};

describe('computeProgressPercent', () => {
  it('没有 currentLessonId 时是 0', () => {
    expect(
      computeProgressPercent({
        progress: null,
        modules: [{ lessons: [{ id: 'l1' }, { id: 'l2' }] }],
      }),
    ).toBe(0);
  });

  it('走到第二课（共 4 课）算出 50', () => {
    expect(
      computeProgressPercent({
        progress: { currentLessonId: 'l2' },
        modules: [{ lessons: [{ id: 'l1' }, { id: 'l2' }] }, { lessons: [{ id: 'l3' }, { id: 'l4' }] }],
      }),
    ).toBe(50);
  });
});

describe('DashboardService.getDashboard', () => {
  it('没有 active enrollment 时 activeCourse 为 null', async () => {
    const prisma = buildPrisma();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user_1',
      displayName: 'Learner',
      email: 'learner@example.com',
      role: 'Learner',
      plan: 'FREE',
      level: 1,
      timezone: 'Asia/Kuala_Lumpur',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    prisma.enrollment.findFirst.mockResolvedValue(null);
    const service = await buildService(prisma);

    const dashboard = await service.getDashboard('user_1');

    expect(dashboard.activeCourse).toBeNull();
    expect(dashboard.progress.skillsMastered).toBe(0);
    expect(dashboard.progress.weeklyHours).toHaveLength(7);
  });

  it('有 active enrollment 时用课程 slug（不是内部 cuid）拼 activeCourse，并算出 progressPercent', async () => {
    const prisma = buildPrisma();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user_1',
      displayName: 'Learner',
      email: 'learner@example.com',
      role: 'Learner',
      plan: 'PREMIUM',
      level: 2,
      timezone: 'Asia/Kuala_Lumpur',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    prisma.enrollment.findFirst.mockResolvedValue({
      id: 'enrollment_1',
      userId: 'user_1',
      active: true,
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
      course: {
        slug: 'sample-course',
        title: 'Sample Course',
        category: 'AI',
        description: 'desc',
        level: 'BEGINNER',
        durationMinutes: 60,
        lessonCount: 4,
        published: true,
        coverAssetId: null,
      },
      progress: { currentLessonId: 'lesson_2' },
      courseVersion: {
        modules: [
          { lessons: [{ id: 'lesson_1' }, { id: 'lesson_2' }] },
          { lessons: [{ id: 'lesson_3' }, { id: 'lesson_4' }] },
        ],
      },
    });
    const service = await buildService(prisma);

    const dashboard = await service.getDashboard('user_1');

    expect(dashboard.activeCourse).not.toBeNull();
    expect(dashboard.activeCourse?.id).toBe('sample-course');
    expect(dashboard.activeCourse?.level).toBe('Beginner');
    expect(dashboard.activeCourse?.enrollment.courseId).toBe('sample-course');
    expect(dashboard.activeCourse?.enrollment.progressPercent).toBe(50);
  });
});

describe('DashboardService.recordPractice', () => {
  it('写一行 PracticeSession', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.recordPractice('user_1', 15);

    expect(prisma.practiceSession.create).toHaveBeenCalledWith({
      data: { userId: 'user_1', minutes: 15 },
    });
  });
});
