import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { signAccessToken } from '../src/auth/tokens';

describe('learning state and snapshots (real PostgreSQL and authenticated HTTP)', () => {
  const database = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
  if (
    database.hostname !== '127.0.0.1' ||
    !['/aivirteach_learning_state'].includes(database.pathname)
  ) {
    throw new Error(
      'Run learning state E2E only against dedicated local aivirteach_learning_state database',
    );
  }

  const prisma = new PrismaClient();
  const slug = `progress-${Date.now()}`;
  let app: INestApplication;
  let userId: string,
    otherId: string,
    courseId: string,
    enrollmentId: string,
    versionId: string,
    token: string,
    otherToken: string;
  const url = () => `/api/v1/courses/${slug}`;
  const get = () =>
    request(app.getHttpServer())
      .get(`${url()}/progress`)
      .set('Authorization', `Bearer ${token}`);
  const set = (
    lesson: string,
    completed: boolean,
    revision: number,
    generation = 0,
    courseVersionId = versionId,
  ) =>
    request(app.getHttpServer())
      .put(`${url()}/lessons/${lesson}/progress`)
      .set('Authorization', `Bearer ${token}`)
      .send({ completed, revision, generation, courseVersionId });
  async function publish(version: number, ids: string[]) {
    return prisma.courseVersion.create({
      data: {
        courseId,
        version,
        publishedAt: new Date(),
        modules: {
          create: {
            position: 1,
            title: 'Module',
            description: '',
            estimatedMinutes: 10,
            lessons: {
              create: ids.map((contentId, i) => ({
                contentId,
                position: i + 1,
                title: contentId,
                estimatedMinutes: 1,
                activityType: 'manual',
                activityPrompt: 'Read',
                activityCompletionType: 'manual',
              })),
            },
          },
        },
      },
    });
  }
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    userId = (
      await prisma.user.create({ data: { email: `${slug}@example.com` } })
    ).id;
    otherId = (
      await prisma.user.create({ data: { email: `${slug}-other@example.com` } })
    ).id;
    token = await signAccessToken(
      { sub: userId, email: `${slug}@example.com` },
      process.env.JWT_SECRET!,
      '15m',
    );
    otherToken = await signAccessToken(
      { sub: otherId, email: `${slug}-other@example.com` },
      process.env.JWT_SECRET!,
      '15m',
    );
    courseId = (
      await prisma.course.create({
        data: { slug, title: 'Progress test', published: true },
      })
    ).id;
    versionId = (await publish(1, ['a', 'b', 'c'])).id;
    enrollmentId = (
      await prisma.enrollment.create({
        data: { userId, courseId, active: true },
      })
    ).id;
  });
  afterAll(async () => {
    if (courseId) await prisma.course.delete({ where: { id: courseId } });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, otherId].filter(Boolean) } },
    });
    await prisma.$disconnect();
    await app?.close();
  });

  it('rejects anonymous, unowned and malformed commands', async () => {
    await request(app.getHttpServer()).get(`${url()}/progress`).expect(401);
    await request(app.getHttpServer())
      .get(`${url()}/progress`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .put(`${url()}/lessons/a/progress`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        completed: true,
        revision: 0,
        generation: 0,
        courseVersionId: versionId,
      })
      .expect(404);
    await request(app.getHttpServer())
      .put(`${url()}/lessons/a/progress`)
      .set('Authorization', `Bearer ${token}`)
      .send({ completed: 'true' })
      .expect(400);
    await set('missing', true, 0).expect(404);
  });
  it('reading never completes; last lesson alone is only 33 percent', async () => {
    const read = await request(app.getHttpServer())
      .put(`${url()}/reading-position`)
      .set('Authorization', `Bearer ${token}`)
      .send({ generation: 0, courseVersionId: versionId, lessonId: 'c' })
      .expect(200);
    expect(read.body).toMatchObject({
      progressPercent: 0,
      revision: 1,
      currentLessonId: 'c',
    });
    const retry = await request(app.getHttpServer())
      .put(`${url()}/reading-position`)
      .set('Authorization', `Bearer ${token}`)
      .send({ generation: 0, courseVersionId: versionId, lessonId: 'c' })
      .expect(200);
    expect(retry.body.revision).toBe(1);
    const result = await set('c', true, 1).expect(200);
    expect(result.body).toMatchObject({
      progressPercent: 33,
      completedLessonIds: ['c'],
      revision: 2,
      status: 'in_progress',
    });
    expect(await prisma.attempt.count({ where: { enrollmentId } })).toBe(0);
  });
  it('retries and unmark/re-mark do not duplicate activity', async () => {
    let state = (await get()).body;
    await set('c', true, state.revision).expect(200);
    state = (await get()).body;
    expect(
      (await set('c', false, state.revision).expect(200)).body.progressPercent,
    ).toBe(0);
    state = (await get()).body;
    await set('c', true, state.revision).expect(200);
    expect(await prisma.activity.count({ where: { enrollmentId } })).toBe(1);
  });
  it('only one of two stale concurrent changes commits', async () => {
    const before = (await get()).body;
    const results = await Promise.all([
      set('a', true, before.revision),
      set('b', true, before.revision),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const state = (await get()).body;
    const missing = ['a', 'b'].find(
      (id) => !state.completedLessonIds.includes(id),
    )!;
    const done = await set(missing, true, state.revision).expect(200);
    expect(done.body).toMatchObject({
      status: 'completed',
      progressPercent: 100,
    });
    expect(done.body.achievements).toHaveLength(1);
    const list = await request(app.getHttpServer())
      .get('/api/v1/me/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body[0].progressPercent).toBe(100);
    const dashboard = await request(app.getHttpServer())
      .get('/api/v1/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.activeCourse.enrollment.progressPercent).toBe(100);
  });
  it('new publication preserves stable IDs and history, rejects old version writes', async () => {
    const old = versionId;
    versionId = (await publish(2, ['c', 'a', 'b', 'd'])).id;
    const state = (await get()).body;
    expect(state).toMatchObject({
      progressPercent: 75,
      completedLessonIds: ['c', 'a', 'b'],
      status: 'in_progress',
    });
    expect(state.achievements).toHaveLength(1);
    await set('d', true, state.revision, 0, old).expect(409);
    await set('a', false, state.revision).expect(200);
    expect((await get()).body.achievements).toHaveLength(1);
  });
  it('manual snapshots are idempotent, pinned to the saved syllabus, immutable and private', async () => {
    const current = (await get()).body;
    const command = {
      requestId: randomUUID(),
      generation: current.generation,
      revision: current.revision,
      courseVersionId: current.courseVersionId,
    };
    const saved = await request(app.getHttpServer())
      .post(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
      .expect(201);
    expect(saved.body).toMatchObject({
      reason: 'MANUAL',
      sourceGeneration: current.generation,
      sourceRevision: current.revision,
      courseVersionId: current.courseVersionId,
      schemaVersion: 1,
    });
    const replay = await request(app.getHttpServer())
      .post(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
      .expect(201);
    expect(replay.body.id).toBe(saved.body.id);
    await set('a', true, current.revision, current.generation).expect(200);
    expect((await get()).body.completedLessonIds).toContain('a');
    versionId = (await publish(3, ['c', 'a', 'b', 'd', 'e'])).id;
    const afterPublishRetry = await request(app.getHttpServer())
      .post(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${token}`)
      .send(command)
      .expect(201);
    expect(afterPublishRetry.body.id).toBe(saved.body.id);
    expect(afterPublishRetry.body.courseVersionId).toBe(
      command.courseVersionId,
    );
    const detail = await request(app.getHttpServer())
      .get(`${url()}/snapshots/${saved.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.state).toEqual(saved.body.state);
    expect(detail.body.courseVersion.version).toBe(2);
    const summaries = await request(app.getHttpServer())
      .get(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(summaries.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: saved.body.id,
          completeStateAvailable: true,
          totalLessons: 4,
        }),
      ]),
    );
    await request(app.getHttpServer())
      .get(`${url()}/snapshots/${saved.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...command, revision: command.revision + 1 })
      .expect(409);
  });
  it('restart fences old requests and keeps history without granting assessment PASS', async () => {
    const previous = (await get()).body;
    const restartCommand = {
      requestId: randomUUID(),
      generation: previous.generation,
      revision: previous.revision,
      courseVersionId: previous.courseVersionId,
    };
    await request(app.getHttpServer())
      .post(`${url()}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .send(restartCommand)
      .expect(201);
    await set('a', true, previous.revision, previous.generation).expect(409);
    expect(
      await prisma.learningSnapshot.count({
        where: { enrollmentId, reason: 'RESTART' },
      }),
    ).toBe(1);
    const snapshotCount = await prisma.learningSnapshot.count({
      where: { enrollmentId, reason: 'RESTART' },
    });
    const ledgerCount = await prisma.quotaLedger.count({ where: { userId } });
    await request(app.getHttpServer())
      .post(`${url()}/restart`)
      .set('Authorization', `Bearer ${token}`)
      .send(restartCommand)
      .expect(201);
    expect((await get()).body.generation).toBe(previous.generation + 1);
    expect(
      await prisma.learningSnapshot.count({
        where: { enrollmentId, reason: 'RESTART' },
      }),
    ).toBe(snapshotCount);
    expect(await prisma.quotaLedger.count({ where: { userId } })).toBe(
      ledgerCount,
    );
    await request(app.getHttpServer())
      .post(`${url()}/enroll`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const state = (await get()).body;
    expect(state).toMatchObject({
      generation: 1,
      revision: 0,
      progressPercent: 0,
      completedLessonIds: [],
      currentLessonId: null,
    });
    expect(state.achievements).toHaveLength(1);
    await set('a', true, 0, 0).expect(409);
    await set('a', true, 0, 1).expect(200);
    expect(
      await prisma.learningSnapshot.count({
        where: { enrollmentId, reason: 'COMPLETED', sourceGeneration: 0 },
      }),
    ).toBe(1);
    expect(await prisma.attempt.count({ where: { enrollmentId } })).toBe(0);
  });
  it('serializes concurrent reading and completion without losing either update after a revision retry', async () => {
    const before = (await get()).body;
    const [completion, reading] = await Promise.all([
      set('e', true, before.revision, before.generation),
      request(app.getHttpServer())
        .put(`${url()}/reading-position`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          generation: before.generation,
          courseVersionId: before.courseVersionId,
          lessonId: 'd',
        }),
    ]);
    expect(reading.status).toBe(200);
    if (completion.status === 409) {
      const refreshed = (await get()).body;
      await set('e', true, refreshed.revision, refreshed.generation).expect(
        200,
      );
    } else {
      expect(completion.status).toBe(200);
    }
    expect((await get()).body).toMatchObject({ currentLessonId: 'd' });
    expect((await get()).body.completedLessonIds).toEqual(
      expect.arrayContaining(['a', 'e']),
    );
  });
  it('returns bounded snapshot pages with a stable cursor', async () => {
    const count = await prisma.learningSnapshot.count({
      where: { enrollmentId },
    });
    const rows = Array.from(
      { length: Math.max(0, 51 - count) },
      (_, index) => ({
        id: `pagination-${String(index).padStart(3, '0')}`,
        enrollmentId,
        sourceGeneration: 99,
        sourceRevision: 0,
        courseVersionId: versionId,
        schemaVersion: 1,
        state: {
          schemaVersion: 1,
          readingLessonId: null,
          lessons: {},
          completedAt: null,
        },
        reason: 'MANUAL' as const,
        idempotencyKey: `pagination:${index}`,
      }),
    );
    if (rows.length) await prisma.learningSnapshot.createMany({ data: rows });
    const first = await request(app.getHttpServer())
      .get(`${url()}/snapshots`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app.getHttpServer())
      .get(`${url()}/snapshots`)
      .query({ cursor: first.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
  it('rolls back completion and revision when activity persistence fails', async () => {
    const before = (await get()).body;
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Activity" ADD CONSTRAINT "progress_rollback_test" CHECK (title <> 'd') NOT VALID`,
    );
    try {
      await set('d', true, before.revision, before.generation).expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "Activity" DROP CONSTRAINT "progress_rollback_test"',
      );
    }
    const after = (await get()).body;
    expect(after.revision).toBe(before.revision);
    expect(after.completedLessonIds).toEqual(before.completedLessonIds);
  });

  it('removes the ambiguous legacy completion endpoint', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/lessons/b/complete')
      .expect(404);
  });
});
