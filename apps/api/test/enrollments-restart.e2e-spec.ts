import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
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
  let versionId: string;
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
    const version = await prisma.courseVersion.create({
      data: { courseId, version: 1, publishedAt: new Date() },
    });
    versionId = version.id;
    const enrollment = await prisma.enrollment.create({
      data: {
        userId,
        courseId,
        courseVersionId: version.id,
        active: true,
        learningState: {
          schemaVersion: 1,
          readingLessonId: 'previous-step',
          lessons: {},
          completedAt: null,
        },
      },
    });
    enrollmentId = enrollment.id;
    await prisma.conversation.create({
      data: {
        enrollmentId,
        threadId: enrollmentId,
        role: 'USER',
        content: 'old chat',
        inputCacheHitTokens: 500,
        inputCacheMissTokens: 100,
        outputTokens: 50,
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
    const command = {
      requestId: randomUUID(),
      generation: 0,
      revision: 0,
      courseVersionId: versionId,
    };
    const restarted = await request(app.getHttpServer())
      .post(`/api/v1/courses/${slug}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
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
      prisma.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } }),
    ).resolves.toMatchObject({
      generation: 1,
      learningState: {
        schemaVersion: 1,
        readingLessonId: null,
        lessons: {},
        completedAt: null,
      },
    });
    await expect(
      prisma.conversation.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.workspace.count({ where: { enrollmentId } }),
    ).resolves.toBe(0);
    expect(deleteVm).toHaveBeenCalledWith(`lab-${stamp}`);
    await expect(
      prisma.quotaLedger.findMany({
        where: { userId },
        select: { tokensDelta: true },
      }),
    ).resolves.toEqual([{ tokensDelta: -310 }]);
    const snapshotCount = await prisma.learningSnapshot.count({
      where: { enrollmentId, reason: 'RESTART' },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/courses/${slug}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
      .expect(201);
    expect(
      await prisma.learningSnapshot.count({
        where: { enrollmentId, reason: 'RESTART' },
      }),
    ).toBe(snapshotCount);
    await expect(prisma.quotaLedger.count({ where: { userId } })).resolves.toBe(
      1,
    );

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

  it('keeps reset retry discoverable and replays one restart while Labs cleanup is failing', async () => {
    await prisma.workspace.create({
      data: {
        enrollmentId,
        status: WorkspaceStatus.RUNNING,
        labId: `lab-fail-${stamp}`,
      },
    });
    deleteVm.mockRejectedValue(new Error('Labs unavailable'));
    const command = {
      requestId: randomUUID(),
      generation: 1,
      revision: 0,
      courseVersionId: versionId,
    };
    const result = await request(app.getHttpServer())
      .post(`/api/v1/courses/${slug}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
      .expect(201);
    expect(result.body.workspaceResetPending).toBe(true);
    expect(
      await prisma.workspace.findUnique({ where: { enrollmentId } }),
    ).toMatchObject({ status: 'RESETTING' });
    const count = await prisma.learningSnapshot.count({
      where: { enrollmentId, reason: 'RESTART', sourceGeneration: 1 },
    });
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/courses/${slug}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
      .expect(201);
    expect(replay.body.workspaceResetPending).toBe(true);
    expect(
      await prisma.learningSnapshot.count({
        where: { enrollmentId, reason: 'RESTART', sourceGeneration: 1 },
      }),
    ).toBe(count);
  });
});
