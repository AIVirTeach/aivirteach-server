import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { TOKEN_WEIGHTS } from '../token-usage/application/check-token-quota';
import { EnrollmentsService } from './enrollments.service';
import { EMPTY_LEARNING_STATE } from './learning-state';

const modules = [
  { title: 'Module', lessons: [{ contentId: 'a' }, { contentId: 'b' }] },
];
const baseEnrollment = {
  id: 'e1',
  userId: 'u1',
  courseId: 'c1',
  courseVersionId: 'v1',
  generation: 0,
  progressRevision: 0,
  active: true,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  learningState: EMPTY_LEARNING_STATE,
};

function setup() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'c1' }]),
    course: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'c1',
        published: true,
        versions: [{ id: 'v1', version: 1, modules }],
      }),
    },
    enrollment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue(baseEnrollment),
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(baseEnrollment),
      findUniqueOrThrow: jest.fn().mockResolvedValue(baseEnrollment),
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({
        ...baseEnrollment,
        active: false,
        generation: 1,
        learningState: EMPTY_LEARNING_STATE,
      }),
    },
    learningSnapshot: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'snapshot1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    conversation: {
      aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    quotaLedger: { create: jest.fn() },
    workspace: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    activity: { create: jest.fn() },
  };
  const prisma = {
    ...tx,
    course: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'c1',
        published: true,
        versions: [{ id: 'v1', version: 1, modules }],
      }),
    },
    $transaction: jest.fn((fn: (arg: typeof tx) => unknown) => fn(tx)),
  };
  const courses = {
    requirePublishedCourseWithLatestVersion: jest.fn().mockResolvedValue({
      id: 'c1',
      slug: 'sample',
      versions: [{ id: 'v1', version: 1, modules }],
    }),
  };
  const audit = { record: jest.fn() };
  const workspace = { finishReset: jest.fn().mockResolvedValue(true) };
  return Test.createTestingModule({
    providers: [
      EnrollmentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: CoursesService, useValue: courses },
      { provide: WorkspaceService, useValue: workspace },
      {
        provide: TOKEN_WEIGHTS,
        useValue: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 },
      },
    ],
  })
    .compile()
    .then((moduleRef) => ({
      service: moduleRef.get(EnrollmentsService),
      prisma,
      tx,
      courses,
      audit,
      workspace,
    }));
}

describe('EnrollmentsService', () => {
  it('propagates a missing or unpublished course without creating an enrollment', async () => {
    const { service, courses, tx } = await setup();
    courses.requirePublishedCourseWithLatestVersion.mockRejectedValue(
      new NotFoundException('missing'),
    );
    await expect(service.enroll('u1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
    expect(tx.enrollment.upsert).not.toHaveBeenCalled();
  });

  it('enrolls against the latest published version and projects its JSON state', async () => {
    const { service, prisma, tx, audit } = await setup();
    await expect(service.enroll('u1', 'sample')).resolves.toMatchObject({
      courseId: 'sample',
      status: 'in_progress',
      progressPercent: 0,
    });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.enrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { active: true, courseVersionId: 'v1' },
      }),
    );
    expect(audit.record).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('projects stable-id completions, reading and historical achievement snapshots', async () => {
    const { service, prisma } = await setup();
    prisma.enrollment.findFirst.mockResolvedValue({
      ...baseEnrollment,
      learningState: {
        schemaVersion: 1,
        readingLessonId: 'b',
        lessons: {
          a: {
            completedAt: '2026-10-02T00:00:00.000Z',
            firstCompletedAt: '2026-10-02T00:00:00.000Z',
          },
        },
        completedAt: null,
      },
      course: { slug: 'sample', versions: [{ id: 'v1', version: 1, modules }] },
      snapshots: [
        {
          sourceGeneration: 0,
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
          state: { completedAt: '2026-10-03T00:00:00.000Z' },
        },
      ],
    });
    await expect(service.getProgress('u1', 'sample')).resolves.toMatchObject({
      completedLessonIds: ['a'],
      currentLessonId: 'b',
      progressPercent: 50,
      achievements: [
        { generation: 0, completedAt: '2026-10-03T00:00:00.000Z' },
      ],
    });
  });

  it('remaps only the reading pointer through the learning-owned transition and advances revision', async () => {
    const { service, tx } = await setup();
    tx.enrollment.findMany.mockResolvedValue([{ id: 'e1' }]);
    tx.enrollment.findUniqueOrThrow.mockResolvedValue({
      ...baseEnrollment,
      learningState: { ...EMPTY_LEARNING_STATE, readingLessonId: 'removed' },
    });
    await service.remapPublishedReadingPointers(
      tx as any,
      'c1',
      new Map([['removed', 'a']]),
    );
    expect(tx.enrollment.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: {
        learningState: { ...EMPTY_LEARNING_STATE, readingLessonId: 'a' },
        progressRevision: { increment: 1 },
      },
    });
  });

  it('restart snapshots and resets atomically, debiting weighted usage before conversation deletion', async () => {
    const { service, tx } = await setup();
    tx.conversation.aggregate.mockResolvedValue({
      _sum: {
        inputCacheHitTokens: 500,
        inputCacheMissTokens: 100,
        outputTokens: 50,
      },
    });
    const result = await service.restart('u1', 'sample', {
      requestId: '096e8c4a-12ef-46c8-900b-200b5323f52f',
      generation: 0,
      revision: 0,
      courseVersionId: 'v1',
    });
    expect(result).toMatchObject({ status: 'not_started', active: false });
    expect(tx.learningSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'RESTART',
          sourceGeneration: 0,
          sourceRevision: 0,
          courseVersionId: 'v1',
        }),
      }),
    );
    expect(tx.quotaLedger.create).toHaveBeenCalledWith({
      data: { userId: 'u1', tokensDelta: -310 },
    });
    expect(tx.quotaLedger.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.conversation.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('zero usage creates no debit and failed VM cleanup returns a pending flag', async () => {
    const { service, tx, workspace } = await setup();
    tx.workspace.updateMany.mockResolvedValue({ count: 1 });
    workspace.finishReset.mockRejectedValue(new Error('Labs unavailable'));
    await expect(
      service.restart('u1', 'sample', {
        requestId: '096e8c4a-12ef-46c8-900b-200b5323f52f',
        generation: 0,
        revision: 0,
        courseVersionId: 'v1',
      }),
    ).resolves.toMatchObject({ workspaceResetPending: true });
    expect(tx.quotaLedger.create).not.toHaveBeenCalled();
    expect(tx.workspace.updateMany).toHaveBeenCalledWith({
      where: { enrollmentId: 'e1' },
      data: { status: 'RESETTING', resetRetryAt: null },
    });
  });

  it('a still-settling VM keeps the cleanup pending without charging zero usage', async () => {
    const { service, tx, workspace } = await setup();
    tx.workspace.updateMany.mockResolvedValue({ count: 1 });
    workspace.finishReset.mockResolvedValue(false);
    await expect(
      service.restart('u1', 'sample', {
        requestId: '096e8c4a-12ef-46c8-900b-200b5323f52f',
        generation: 0,
        revision: 0,
        courseVersionId: 'v1',
      }),
    ).resolves.toMatchObject({ workspaceResetPending: true });
    expect(tx.quotaLedger.create).not.toHaveBeenCalled();
  });

  it('restart re-reads latest published version under the course lock', async () => {
    const { service, tx } = await setup();
    tx.course.findFirst.mockResolvedValue({
      id: 'c1',
      published: true,
      versions: [{ id: 'v2', version: 2, modules }],
    });
    await service.restart('u1', 'sample', {
      requestId: '096e8c4a-12ef-46c8-900b-200b5323f52f',
      generation: 0,
      revision: 0,
      courseVersionId: 'v2',
    });
    expect(tx.learningSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ courseVersionId: 'v2' }),
      }),
    );
    expect(tx.enrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ courseVersionId: 'v2' }),
      }),
    );
  });
});
