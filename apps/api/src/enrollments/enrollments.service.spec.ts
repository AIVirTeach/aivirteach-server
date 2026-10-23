import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { LATEST_PUBLISHED_VERSION } from '../courses/published-version';
import { TOKEN_WEIGHTS } from '../token-usage/application/check-token-quota';
import { WorkspaceService } from '../workspace/workspace.service';
import { EnrollmentsService } from './enrollments.service';

const WEIGHTS = { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 };

const buildPrisma = () => {
  const prisma = {
    enrollment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    progress: { upsert: jest.fn() },
    activity: { create: jest.fn() },
    conversation: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          inputCacheHitTokens: null,
          inputCacheMissTokens: null,
          outputTokens: null,
        },
      }),
    },
    quotaLedger: { create: jest.fn().mockResolvedValue({}) },
    workspace: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(),
  };
  // enroll/restart 用 interactive transaction；测试里直接把同一个 prisma 当 tx 传回调用方，
  // 这样 jest 对 prisma.enrollment.xxx 的断言在事务内外都指向同一个 mock。
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  return prisma;
};

const buildCoursesService = () => ({
  requirePublishedCourseWithLatestVersion: jest.fn(),
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  audit = { record: jest.fn() },
  coursesService = buildCoursesService(),
  workspaceService = { finishReset: jest.fn().mockResolvedValue(true) },
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EnrollmentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: CoursesService, useValue: coursesService },
      { provide: WorkspaceService, useValue: workspaceService },
      { provide: TOKEN_WEIGHTS, useValue: WEIGHTS },
    ],
  }).compile();
  return {
    service: moduleRef.get(EnrollmentsService),
    audit,
    coursesService,
    workspaceService,
  };
};

const USER_ID = 'user_1';

const SAMPLE_COURSE = {
  id: 'course_1',
  slug: 'sample',
  title: 'Sample',
  category: 'cat',
  description: 'desc',
  level: 'BEGINNER',
  durationMinutes: 30,
  lessonCount: 2,
  published: true,
  coverAssetId: null,
  versions: [{ id: 'version_1', version: 1, modules: [] }],
};

describe('EnrollmentsService.enroll', () => {
  it('课程不存在或未发布时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockRejectedValue(
      new NotFoundException('找不到课程：missing'),
    );
    const { service } = await buildService(prisma, undefined, coursesService);

    await expect(service.enroll(USER_ID, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('先把其他课程的 enrollment 设成 active=false，再 upsert 这门课为 active=true 并绑定最新版本，记审计', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      SAMPLE_COURSE,
    );
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: true,
      currentModule: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    const { service, audit } = await buildService(
      prisma,
      undefined,
      coursesService,
    );

    const result = await service.enroll(USER_ID, 'sample');

    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, active: true },
      data: { active: false },
    });
    expect(prisma.enrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_courseId: { userId: USER_ID, courseId: 'course_1' } },
        update: { active: true, courseVersionId: 'version_1' },
        create: expect.objectContaining({
          userId: USER_ID,
          courseId: 'course_1',
          courseVersionId: 'version_1',
          active: true,
        }),
      }),
    );
    expect(result.courseId).toBe('sample');
    expect(result.progressPercent).toBe(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.USER, id: USER_ID },
        action: 'enrollment.enroll',
      }),
    );
    // updateMany 和 upsert 必须在同一个事务里，否则并发/重试请求可能留下 0 个或 2 个 active enrollment。
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('courseVersionId 绑定课程返回的最大已发布版本', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue({
      ...SAMPLE_COURSE,
      versions: [
        { id: 'version_3', version: 3, modules: [] },
        { id: 'version_2', version: 2, modules: [] },
      ],
    });
    prisma.enrollment.upsert.mockResolvedValue(
      upsertedEnrollment({ progress: null }),
    );
    const { service } = await buildService(prisma, undefined, coursesService);

    await service.enroll(USER_ID, 'sample');

    expect(prisma.enrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { active: true, courseVersionId: 'version_3' },
        create: expect.objectContaining({ courseVersionId: 'version_3' }),
      }),
    );
  });

  const COURSE_WITH_LESSONS = {
    ...SAMPLE_COURSE,
    versions: [
      {
        id: 'version_1',
        version: 1,
        modules: [
          {
            title: 'Module One',
            lessons: [
              { contentId: 'lesson_cuid_1' },
              { contentId: 'lesson_cuid_2' },
            ],
          },
        ],
      },
    ],
  };
  const upsertedEnrollment = (overrides: Record<string, unknown>) => ({
    id: 'enrollment_1',
    userId: USER_ID,
    courseId: 'course_1',
    active: true,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    completedAt: null,
    progress: null,
    ...overrides,
  });

  it('重新报名一门学到一半的课：status 是 in_progress，progressPercent 按进度算而不是写死 0', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      COURSE_WITH_LESSONS,
    );
    prisma.enrollment.upsert.mockResolvedValue(
      upsertedEnrollment({
        progress: { currentLessonContentId: 'lesson_cuid_1' },
        lessonProgress: [
          {
            generation: 0,
            contentId: 'lesson_cuid_2',
            completedAt: new Date(),
          },
        ],
      }),
    );
    const { service } = await buildService(prisma, undefined, coursesService);

    const result = await service.enroll(USER_ID, 'sample');

    expect(result).toEqual(
      expect.objectContaining({ status: 'in_progress', progressPercent: 50 }),
    );
  });

  it('重新报名一门已完成的课：status 是 completed，progressPercent 是 100', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      COURSE_WITH_LESSONS,
    );
    prisma.enrollment.upsert.mockResolvedValue(
      upsertedEnrollment({
        lessonProgress: ['lesson_cuid_1', 'lesson_cuid_2'].map((contentId) => ({
          contentId,
          generation: 0,
          completedAt: new Date(),
        })),
        completedAt: new Date('2026-09-01T00:00:00Z'),
        progress: { currentLessonContentId: null },
      }),
    );
    const { service } = await buildService(prisma, undefined, coursesService);

    const result = await service.enroll(USER_ID, 'sample');

    expect(result).toEqual(
      expect.objectContaining({ status: 'completed', progressPercent: 100 }),
    );
  });
});

describe('EnrollmentsService.restart', () => {
  const restartWithConsumption = async (sum: {
    inputCacheHitTokens: number | null;
    inputCacheMissTokens: number | null;
    outputTokens: number | null;
  }) => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      SAMPLE_COURSE,
    );
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: true,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      completedAt: null,
    });
    prisma.conversation.aggregate.mockResolvedValue({ _sum: sum });
    const { service } = await buildService(prisma, undefined, coursesService);
    await service.restart(USER_ID, 'sample');
    return prisma;
  };

  it('清空对话前把这些对话的加权消耗结算成负的 QuotaLedger，余额不因 restart 回升', async () => {
    // 500*0.02 + 100*1 + 50*4 = 310
    const prisma = await restartWithConsumption({
      inputCacheHitTokens: 500,
      inputCacheMissTokens: 100,
      outputTokens: 50,
    });

    expect(prisma.conversation.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enrollmentId: 'enrollment_1' } }),
    );
    expect(prisma.quotaLedger.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, tokensDelta: -310 },
    });
    // 必须先结算再删，否则消耗已经随对话一起没了。
    expect(prisma.quotaLedger.create.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.conversation.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('没有任何已计量的消耗时不写 QuotaLedger', async () => {
    const prisma = await restartWithConsumption({
      inputCacheHitTokens: null,
      inputCacheMissTokens: null,
      outputTokens: null,
    });

    expect(prisma.quotaLedger.create).not.toHaveBeenCalled();
    expect(prisma.conversation.deleteMany).toHaveBeenCalled();
  });

  it('把 updateMany/upsert/progress.upsert 放进同一个事务，重置进度到第一课', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      SAMPLE_COURSE,
    );
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: true,
      currentModule: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    const { service } = await buildService(prisma, undefined, coursesService);

    const result = await service.restart(USER_ID, 'sample');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, active: true },
      data: { active: false },
    });
    expect(prisma.enrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          active: false,
          generation: { increment: 1 },
          progressRevision: 0,
          courseVersionId: 'version_1',
          completedAt: null,
        },
        create: expect.objectContaining({ active: false }),
      }),
    );
    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollmentId: 'enrollment_1' },
        update: { currentLessonId: null, currentLessonContentId: null },
        create: {
          enrollmentId: 'enrollment_1',
          currentLessonId: null,
          currentLessonContentId: null,
        },
      }),
    );
    expect(result.courseId).toBe('sample');
    // restart 后课程回到“未开始”，client 靠这个把卡片切回 Start course。
    expect(result.status).toBe('not_started');
  });

  it('restart 后保持未激活，刷新 enrollment 仍未激活，重新 enroll 才变成进行中', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue({
      ...SAMPLE_COURSE,
      versions: [
        {
          id: 'version_1',
          version: 1,
          modules: [
            {
              title: 'Module One',
              lessons: [{ contentId: 'lesson_1' }, { contentId: 'lesson_2' }],
            },
          ],
        },
      ],
    });
    const restartedEnrollment = {
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: false,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      completedAt: null,
    };
    prisma.enrollment.upsert
      .mockResolvedValueOnce(restartedEnrollment)
      .mockResolvedValueOnce({
        ...restartedEnrollment,
        active: true,
        progress: { currentLessonContentId: null },
      });
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({
        ...restartedEnrollment,
        progress: { currentLessonContentId: null },
      }),
    ]);
    const { service } = await buildService(prisma, undefined, coursesService);

    const restarted = await service.restart(USER_ID, 'sample');
    const [refreshed] = await service.listForUser(USER_ID);
    const started = await service.enroll(USER_ID, 'sample');

    expect(prisma.enrollment.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        update: expect.objectContaining({ active: false }),
        create: expect.objectContaining({ active: false }),
      }),
    );
    expect(restarted).toEqual(
      expect.objectContaining({
        active: false,
        status: 'not_started',
        progressPercent: 0,
      }),
    );
    expect(refreshed).toEqual(
      expect.objectContaining({
        active: false,
        status: 'not_started',
        progressPercent: 0,
      }),
    );
    expect(started).toEqual(
      expect.objectContaining({
        active: true,
        status: 'in_progress',
        progressPercent: 0,
      }),
    );
    expect(prisma.enrollment.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: expect.objectContaining({ active: true }),
        create: expect.objectContaining({ active: true }),
      }),
    );
  });

  it('restart 保留待清理 workspace；Labs 删除失败时返回待清理状态，供后续重试', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      SAMPLE_COURSE,
    );
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: false,
      completedAt: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    const workspaceService = {
      finishReset: jest.fn().mockRejectedValue(new Error('Labs unavailable')),
    };
    const { service } = await buildService(
      prisma,
      undefined,
      coursesService,
      workspaceService,
    );

    const result = await service.restart(USER_ID, 'sample');

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { enrollmentId: 'enrollment_1' },
      data: { status: 'RESETTING', resetRetryAt: null },
    });
    expect(workspaceService.finishReset).toHaveBeenCalledWith('enrollment_1');
    expect(result).toEqual(
      expect.objectContaining({
        active: false,
        status: 'not_started',
        progressPercent: 0,
        workspaceResetPending: true,
      }),
    );
  });

  it('旧 VM 创建尚未结束时，restart 返回清理待完成', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(
      SAMPLE_COURSE,
    );
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: false,
      completedAt: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 });
    const workspaceService = {
      finishReset: jest.fn().mockResolvedValue(false),
    };
    const { service } = await buildService(
      prisma,
      undefined,
      coursesService,
      workspaceService,
    );

    await expect(service.restart(USER_ID, 'sample')).resolves.toEqual(
      expect.objectContaining({
        active: false,
        status: 'not_started',
        workspaceResetPending: true,
      }),
    );
  });

  it('restart 也绑定最大已发布版本', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue({
      ...SAMPLE_COURSE,
      versions: [
        { id: 'version_2', version: 2, modules: [] },
        { id: 'version_1', version: 1, modules: [] },
      ],
    });
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: true,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      completedAt: null,
    });
    const { service } = await buildService(prisma, undefined, coursesService);

    await service.restart(USER_ID, 'sample');

    expect(prisma.enrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ courseVersionId: 'version_2' }),
        create: expect.objectContaining({ courseVersionId: 'version_2' }),
      }),
    );
  });
});

describe('EnrollmentsService.listForUser', () => {
  it('每条 enrollment 都带上 status', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({
        id: 'fresh',
        active: false,
        progress: null,
        completedAt: null,
      }),
      buildEnrollment({
        id: 'midway',
        progress: { currentLessonContentId: 'verify-network' },
        completedAt: null,
      }),
      buildEnrollment({
        id: 'done',
        lessonProgress: ['verify-virtual-machine', 'verify-network'].map(
          (contentId) => ({
            contentId,
            generation: 0,
            completedAt: new Date(),
          }),
        ),
        progress: { currentLessonContentId: null },
        completedAt: new Date(),
      }),
    ]);
    const { service } = await buildService(prisma);

    const result = await service.listForUser(USER_ID);

    expect(prisma.enrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          course: { include: { versions: LATEST_PUBLISHED_VERSION } },
        }),
      }),
    );

    expect(result.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'fresh', status: 'not_started' },
      { id: 'midway', status: 'in_progress' },
      { id: 'done', status: 'completed' },
    ]);
  });

  it('已完成的课程 progressPercent 为 100（学完后课时指针为空，不能按指针算成 0）', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({
        id: 'done',
        lessonProgress: ['verify-virtual-machine', 'verify-network'].map(
          (contentId) => ({
            contentId,
            generation: 0,
            completedAt: new Date(),
          }),
        ),
        progress: { currentLessonContentId: null },
        completedAt: new Date(),
      }),
    ]);
    const { service } = await buildService(prisma);

    const [done] = await service.listForUser(USER_ID);

    expect(done.progressPercent).toBe(100);
  });
});

const buildEnrollment = (overrides: Record<string, unknown>) => ({
  id: 'enrollment_1',
  userId: USER_ID,
  courseId: 'course_1',
  active: true,
  generation: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
  course: {
    slug: 'sample',
    versions: [
      {
        id: 'version_1',
        modules: [
          {
            lessons: [
              { contentId: 'verify-virtual-machine', title: 'Lesson One' },
              { contentId: 'verify-network', title: 'Lesson Two' },
            ],
          },
        ],
      },
    ],
    ...(overrides.course as object | undefined),
  },
});
