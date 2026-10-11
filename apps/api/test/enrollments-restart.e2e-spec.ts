import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, WorkspaceStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { signAccessToken } from '../src/auth/tokens';
import { LabsClient } from '../src/workspace/labs-client';

describe('Enrollment restart -> refresh -> enroll (database and HTTP)', () => {
  const prisma = new PrismaClient();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `restart-e2e-${stamp}@example.com`;
  const slug = `restart-e2e-${stamp}`;
  let app: INestApplication;
  let userId: string;
  let courseId: string;
  let enrollmentId: string;
  let token: string;
  let deleteVm: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    deleteVm = jest
      .spyOn(app.get(LabsClient), 'deleteVm')
      .mockResolvedValue(undefined);

    const user = await prisma.user.create({ data: { email } });
    userId = user.id;
    const course = await prisma.course.create({
      data: { slug, title: 'Restart E2E', published: true },
    });
    courseId = course.id;
    await prisma.courseVersion.create({
      data: { courseId, version: 1, publishedAt: new Date() },
    });
    const enrollment = await prisma.enrollment.create({
      data: { userId, courseId, active: true },
    });
    enrollmentId = enrollment.id;
    await prisma.progress.create({
      data: { enrollmentId, currentLessonContentId: 'previous-step' },
    });
    await prisma.conversation.create({
      data: {
        enrollmentId,
        threadId: enrollmentId,
        role: 'USER',
        content: 'old chat',
      },
    });
    await prisma.workspace.create({
      data: {
        enrollmentId,
        status: WorkspaceStatus.RUNNING,
        labId: `lab-${stamp}`,
        lastSeenAt: new Date(),
      },
    });
    token = await signAccessToken(
      { sub: userId, email },
      process.env.JWT_SECRET ?? '',
      '15m',
    );
  });

  afterAll(async () => {
    deleteVm?.mockRestore();
    if (courseId) await prisma.course.deleteMany({ where: { id: courseId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    if (app) await app.close();
  });

  it('returns the persisted reset state and starts again only on enroll', async () => {
    const restarted = await request(app.getHttpServer())
      .post(`/api/v1/courses/${slug}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(restarted.body).toMatchObject({
      active: false,
      status: 'not_started',
      progressPercent: 0,
      workspaceResetPending: false,
    });

    const refreshed = await request(app.getHttpServer())
      .get('/api/v1/me/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(refreshed.body).toEqual([
      expect.objectContaining({
        active: false,
        status: 'not_started',
        progressPercent: 0,
      }),
    ]);
    expect(
      refreshed.body.some(
        (enrollment: { active: boolean }) => enrollment.active,
      ),
    ).toBe(false);
    await expect(
      prisma.progress.findUniqueOrThrow({ where: { enrollmentId } }),
    ).resolves.toMatchObject({
      currentLessonId: null,
      currentLessonContentId: null,
    });
    await expect(
      prisma.conversation.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.workspace.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
    expect(deleteVm).toHaveBeenCalledWith(`lab-${stamp}`);

    const started = await request(app.getHttpServer())
      .post(`/api/v1/courses/${slug}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(started.body).toMatchObject({
      active: true,
      status: 'in_progress',
      progressPercent: 0,
    });
    const reloaded = await request(app.getHttpServer())
      .get('/api/v1/me/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(reloaded.body).toEqual([
      expect.objectContaining({
        active: true,
        status: 'in_progress',
        progressPercent: 0,
      }),
    ]);
  });
});
