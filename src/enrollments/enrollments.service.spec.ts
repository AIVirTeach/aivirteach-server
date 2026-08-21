import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { EnrollmentsService } from './enrollments.service';

const buildPrisma = () => {
  const prisma = {
    enrollment: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    progress: { upsert: jest.fn() },
    activity: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  // enroll/restart 用 interactive transaction；测试里直接把同一个 prisma 当 tx 传回调用方，
  // 这样 jest 对 prisma.enrollment.xxx 的断言在事务内外都指向同一个 mock。
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return prisma;
};

const buildCoursesService = () => ({
  requirePublishedCourseWithLatestVersion: jest.fn(),
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  audit = { record: jest.fn() },
  coursesService = buildCoursesService(),
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EnrollmentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: CoursesService, useValue: coursesService },
    ],
  }).compile();
  return { service: moduleRef.get(EnrollmentsService), audit, coursesService };
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

    await expect(service.enroll(USER_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('先把其他课程的 enrollment 设成 active=false，再 upsert 这门课为 active=true 并绑定最新版本，记审计', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(SAMPLE_COURSE);
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: true,
      currentModule: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    const { service, audit } = await buildService(prisma, undefined, coursesService);

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
});

describe('EnrollmentsService.restart', () => {
  it('把 updateMany/upsert/progress.upsert 放进同一个事务，重置进度到第一课', async () => {
    const prisma = buildPrisma();
    const coursesService = buildCoursesService();
    coursesService.requirePublishedCourseWithLatestVersion.mockResolvedValue(SAMPLE_COURSE);
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
        update: { active: true, currentModuleId: null, courseVersionId: 'version_1' },
      }),
    );
    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollmentId: 'enrollment_1' },
        update: { currentLessonId: null },
      }),
    );
    expect(result.courseId).toBe('sample');
  });
});

const buildEnrollment = (overrides: Record<string, unknown>) => ({
  id: 'enrollment_1',
  userId: USER_ID,
  courseId: 'course_1',
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  course: { slug: 'sample' },
  currentModule: null,
  courseVersion: {
    modules: [
      {
        lessons: [
          { id: 'lesson_cuid_1', contentId: 'verify-virtual-machine', title: 'Lesson One' },
          { id: 'lesson_cuid_2', contentId: 'verify-network', title: 'Lesson Two' },
        ],
      },
    ],
  },
  ...overrides,
});

describe('EnrollmentsService.completeLesson', () => {
  it('用户完全没有报名任何课程时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([]);
    const { service } = await buildService(prisma);

    await expect(service.completeLesson(USER_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('contentId 在用户已报名的所有课程里都找不到时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    const { service } = await buildService(prisma);

    await expect(service.completeLesson(USER_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('写一行 Activity，并把 Progress 推进到下一课', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([buildEnrollment({})]);
    const { service } = await buildService(prisma);

    // 路由参数是 content id（"verify-virtual-machine"），不是内部 cuid；
    // 同一个 contentId 在不同课程里可能重复，所以要在用户所有报名里查这个 contentId 属于哪门课，
    // 而不是只信任 active enrollment（否则一个过期的 active 指针会让完成请求记错课程）。
    const result = await service.completeLesson(USER_ID, 'verify-virtual-machine');

    expect(prisma.enrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
    expect(prisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER_ID, enrollmentId: 'enrollment_1', kind: 'LESSON' }),
      }),
    );
    // Progress.currentLessonId 是内部外键，存的是 cuid，不是 content id。
    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollmentId: 'enrollment_1' },
        update: { currentLessonId: 'lesson_cuid_2' },
        create: expect.objectContaining({ enrollmentId: 'enrollment_1', currentLessonId: 'lesson_cuid_2' }),
      }),
    );
    // currentLessonId 推进到 lesson_cuid_2（第 2/2 课），返回值要带上更新后的 enrollment，
    // client 完成课时后靠这个更新本地状态。
    expect(result).toEqual(
      expect.objectContaining({ id: 'enrollment_1', courseId: 'sample', progressPercent: 100 }),
    );
  });

  it('只有非 active 的报名里有这个课时时，仍然可以完成（不再要求这门课是当前 active 课程）', async () => {
    const prisma = buildPrisma();
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({ id: 'enrollment_inactive', active: false, course: { slug: 'old-course' } }),
    ]);
    const { service } = await buildService(prisma);

    const result = await service.completeLesson(USER_ID, 'verify-virtual-machine');

    expect(result).toEqual(expect.objectContaining({ id: 'enrollment_inactive', courseId: 'old-course' }));
  });

  it('contentId 同时存在于用户的多门已报名课程时，用 active 的那门并留审计记录', async () => {
    const prisma = buildPrisma();
    const audit = { record: jest.fn() };
    prisma.enrollment.findMany.mockResolvedValue([
      buildEnrollment({ id: 'enrollment_inactive', active: false, course: { slug: 'course-a' } }),
      buildEnrollment({ id: 'enrollment_active', active: true, course: { slug: 'course-b' } }),
    ]);
    const { service } = await buildService(prisma, audit);

    const result = await service.completeLesson(USER_ID, 'verify-virtual-machine');

    expect(result).toEqual(expect.objectContaining({ id: 'enrollment_active', courseId: 'course-b' }));
    expect(prisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enrollmentId: 'enrollment_active' }) }),
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
