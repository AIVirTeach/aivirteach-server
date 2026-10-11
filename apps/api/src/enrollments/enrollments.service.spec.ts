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

describe('EnrollmentsService.completeLesson', () => {
  it('旧代次的完成请求在 restart 后不能写回进度或完成时间', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({ generation: 0 }),
    ]);
    prisma.enrollment.updateMany.mockResolvedValue({ count: 0 });
    const { service } = await buildService(prisma);

    await expect(
      service.completeLesson(USER_ID, 'verify-network'),
    ).rejects.toThrow();
    expect(prisma.progress.upsert).not.toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });
  it('用户完全没有报名任何课程时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([]);
    const { service } = await buildService(prisma);

    await expect(service.completeLesson(USER_ID, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('contentId 在用户已报名的所有课程里都找不到时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    const { service } = await buildService(prisma);

    await expect(service.completeLesson(USER_ID, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('即使 enrollment.courseVersion 指向旧版，仍按最新发布版本查找和推进课时', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({
        courseVersion: {
          modules: [
            { lessons: [{ contentId: 'old-only', title: 'Old lesson' }] },
          ],
        },
        course: {
          slug: 'sample',
          versions: [
            {
              id: 'version_2',
              modules: [
                {
                  lessons: [
                    { contentId: 'latest-first', title: 'Latest first' },
                    { contentId: 'latest-next', title: 'Latest next' },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ]);
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(USER_ID, 'latest-first');

    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { currentLessonContentId: 'latest-next' },
      }),
    );
    expect(result.progressPercent).toBe(100);
    await expect(service.completeLesson(USER_ID, 'old-only')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('写一行 Activity，并把 Progress 推进到下一课', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    const { service } = await buildService(prisma);

    // 路由参数是 content id（"verify-virtual-machine"），不是内部 cuid；
    // 同一个 contentId 在不同课程里可能重复，所以要在用户所有报名里查这个 contentId 属于哪门课，
    // 而不是只信任 active enrollment（否则一个过期的 active 指针会让完成请求记错课程）。
    const result = await service.completeLesson(
      USER_ID,
      'verify-virtual-machine',
    );

    expect(prisma.enrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        include: expect.objectContaining({
          course: { include: { versions: LATEST_PUBLISHED_VERSION } },
        }),
      }),
    );
    expect(prisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          enrollmentId: 'enrollment_1',
          kind: 'LESSON',
        }),
      }),
    );
    // Progress.currentLessonContentId 与 lesson 的 contentId 使用同一个稳定标识。
    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollmentId: 'enrollment_1' },
        update: { currentLessonContentId: 'verify-network' },
        create: expect.objectContaining({
          enrollmentId: 'enrollment_1',
          currentLessonContentId: 'verify-network',
        }),
      }),
    );
    // currentLessonContentId 推进到 verify-network（第 2/2 课），返回值要带上更新后的 enrollment，
    // client 完成课时后靠这个更新本地状态。
    expect(result).toEqual(
      expect.objectContaining({
        id: 'enrollment_1',
        courseId: 'sample',
        progressPercent: 100,
        status: 'in_progress',
      }),
    );
    // 还没学完最后一课，不能写 completedAt。
    expect(prisma.enrollment.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ completedAt: expect.any(Date) }),
      }),
    );
  });

  it('完成最后一课时写入 completedAt，返回 completed 且进度为 100', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(USER_ID, 'verify-network');

    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { currentLessonContentId: null },
        create: expect.objectContaining({ currentLessonContentId: null }),
      }),
    );

    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enrollment_1', completedAt: null },
      data: { completedAt: expect.any(Date) },
    });
    expect(result.status).toBe('completed');
    expect(result.progressPercent).toBe(100);
  });

  it('完成最后一课时，Activity、completedAt、Progress 三次写入都在同一个事务里', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    // 事务内外用不同的 mock，才能断言写入确实走的是 tx。
    const tx = {
      progress: { upsert: jest.fn() },
      enrollment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activity: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    const { service } = await buildService(prisma);

    await service.completeLesson(USER_ID, 'verify-network');

    expect(tx.activity.create).toHaveBeenCalled();
    expect(tx.progress.upsert).toHaveBeenCalled();
    expect(tx.enrollment.updateMany).toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
    expect(prisma.progress.upsert).not.toHaveBeenCalled();
    expect(prisma.enrollment.updateMany).not.toHaveBeenCalled();
  });

  it('事务内先锁 Enrollment 再写 Progress，和 restart 的加锁顺序一致，避免并发时互相死锁', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    const { service } = await buildService(prisma);

    await service.completeLesson(USER_ID, 'verify-network');

    const [enrollmentWrite] =
      prisma.enrollment.updateMany.mock.invocationCallOrder;
    const [progressWrite] = prisma.progress.upsert.mock.invocationCallOrder;
    expect(enrollmentWrite).toBeLessThan(progressWrite);
  });

  it('事务失败时不留下孤立的 Activity 记录', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    prisma.$transaction.mockRejectedValue(new Error('boom'));
    const { service } = await buildService(prisma);

    await expect(
      service.completeLesson(USER_ID, 'verify-network'),
    ).rejects.toThrow('boom');

    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('已完成的课回看前面的课：不重写 completedAt，仍返回 completed 和 100', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({ completedAt: new Date('2026-01-01T00:00:00Z') }),
    ]);
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(
      USER_ID,
      'verify-virtual-machine',
    );

    expect(prisma.enrollment.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ completedAt: expect.any(Date) }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ status: 'completed', progressPercent: 100 }),
    );
  });

  it('已完成的课再次完成最后一课时，只允许写入 completedAt 为空的行，保留首次完成时间', async () => {
    const prisma = buildPrisma();
    const firstCompletedAt = new Date('2026-01-01T00:00:00Z');
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({ completedAt: firstCompletedAt }),
    ]);
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(USER_ID, 'verify-network');

    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'enrollment_1', completedAt: null },
      }),
    );
    expect(result.status).toBe('completed');
  });

  it('并发完成：事务外读到 completedAt 为空、但库里已被抢先写入时，条件写入不覆盖，仍返回 completed', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({ completedAt: null }),
    ]);
    // 另一个请求已经写过 completedAt，这次带 completedAt: null 条件的写入命中 0 行。
    prisma.enrollment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(USER_ID, 'verify-network');

    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'enrollment_1', completedAt: null },
      }),
    );
    expect(result.status).toBe('completed');
  });

  it('只有非 active 的报名里有这个课时时，仍然可以完成（不再要求这门课是当前 active 课程）', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({
        id: 'enrollment_inactive',
        active: false,
        course: { slug: 'old-course' },
      }),
    ]);
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(
      USER_ID,
      'verify-virtual-machine',
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: 'enrollment_inactive',
        courseId: 'old-course',
      }),
    );
  });

  it('contentId 同时存在于用户的多门已报名课程时，用 active 的那门并留审计记录', async () => {
    const prisma = buildPrisma();
    const audit = { record: jest.fn() };
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({
        id: 'enrollment_inactive',
        active: false,
        course: { slug: 'course-a' },
      }),
      buildEnrollment({
        id: 'enrollment_active',
        active: true,
        course: { slug: 'course-b' },
      }),
    ]);
    const { service } = await buildService(prisma, audit);

    const result = await service.completeLesson(
      USER_ID,
      'verify-virtual-machine',
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: 'enrollment_active',
        courseId: 'course-b',
      }),
    );
    expect(prisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enrollmentId: 'enrollment_active' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'enrollment.completeLesson.ambiguousContentId',
        targetType: 'CourseLesson',
        targetId: 'verify-virtual-machine',
      }),
    );
  });
});
