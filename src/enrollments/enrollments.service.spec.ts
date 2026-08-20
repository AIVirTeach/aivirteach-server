import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { EnrollmentsService } from './enrollments.service';

const buildPrisma = () => ({
  enrollment: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  progress: { upsert: jest.fn() },
  courseLesson: { findUnique: jest.fn() },
  activity: { create: jest.fn() },
});

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
  });
});

describe('EnrollmentsService.completeLesson', () => {
  it('课时不存在时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.courseLesson.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(service.completeLesson(USER_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('写一行 Activity，并把 Progress 推进到下一课', async () => {
    const prisma = buildPrisma();
    prisma.courseLesson.findUnique.mockResolvedValue({
      id: 'lesson_1',
      title: 'Lesson One',
      module: {
        id: 'module_1',
        courseVersion: {
          courseId: 'course_1',
          modules: [
            {
              lessons: [{ id: 'lesson_1' }, { id: 'lesson_2' }],
            },
          ],
        },
      },
    });
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'enrollment_1' });
    const { service } = await buildService(prisma);

    await service.completeLesson(USER_ID, 'lesson_1');

    expect(prisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER_ID, enrollmentId: 'enrollment_1', kind: 'LESSON' }),
      }),
    );
    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollmentId: 'enrollment_1' },
        update: { currentLessonId: 'lesson_2' },
        create: expect.objectContaining({ enrollmentId: 'enrollment_1', currentLessonId: 'lesson_2' }),
      }),
    );
  });
});
