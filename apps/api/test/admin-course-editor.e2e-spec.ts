import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  CourseListItemSchema,
  CourseDraftReadSchema,
  CourseAssetSchema,
  DraftVersionSchema,
  DraftSummarySchema,
  PublishErrorSchema,
} from '@aivirteach/admin-contract';
import { AuditService } from '../src/audit/audit.service';
import { AppModule } from '../src/app.module';
import { configureBodyParsers } from '../src/body-parsers';
import {
  createOperatorSession,
  type OperatorSession,
} from './helpers/operator-session';

describe('admin course editor API', () => {
  const prisma = new PrismaClient();
  let app: NestExpressApplication;
  let operator: OperatorSession;
  const stamp = Date.now();
  const slugs = [`editor-a-${stamp}`, `editor-b-${stamp}`];
  const emails = [
    `editor-active-${stamp}@example.com`,
    `editor-inactive-${stamp}@example.com`,
  ];
  const base = '/api/v1/admin/courses';
  const admin = (req: request.Test) =>
    req.set('Authorization', `Bearer ${operator.token}`);
  const path = (suffix: string, slug = slugs[0]) => `${base}/${slug}${suffix}`;
  const validContent = {
    schemaVersion: 1,
    blocks: [{ id: 'p', type: 'paragraph', props: { text: 'Lesson text' } }],
  };
  let moduleId: string;

  beforeAll(async () => {
    operator = await createOperatorSession(prisma, 'e2e');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureBodyParsers(app);
    app.setGlobalPrefix('api/v1');
    await app.init();
    for (const slug of slugs) {
      await admin(
        request(app.getHttpServer()).post(base).send({ slug, title: slug }),
      ).expect(201);
    }
    const created = await admin(
      request(app.getHttpServer())
        .post(path('/draft/modules'))
        .send({ title: 'Module', description: '', estimatedMinutes: 5 }),
    ).expect(201);
    moduleId = DraftSummarySchema.parse(created.body).modules[0].id;
    for (const contentId of ['one', 'two']) {
      await admin(
        request(app.getHttpServer())
          .post(path(`/draft/modules/${moduleId}/lessons`))
          .send({
            contentId,
            title: 'Same title',
            estimatedMinutes: 2,
            content: validContent,
            activity: { type: 'reading', prompt: '', completionType: 'manual' },
          }),
      ).expect(201);
    }
  });

  afterAll(async () => {
    await operator?.cleanup();
    await prisma.course.deleteMany({ where: { slug: { in: slugs } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
    await app?.close();
  });

  it('requires operator authentication for the new routes', async () => {
    await request(app.getHttpServer()).get(base).expect(401);
    await request(app.getHttpServer()).get(path('/assets')).expect(401);
    await request(app.getHttpServer())
      .post(path('/draft/lessons/one/assessments'))
      .send({ type: 'quiz', question: 'Q' })
      .expect(401);
  });

  it('lists draft lesson counts and only active enrollments', async () => {
    const course = await prisma.course.findUniqueOrThrow({
      where: { slug: slugs[0] },
    });
    for (const [index, email] of emails.entries()) {
      const user = await prisma.user.create({ data: { email } });
      await prisma.enrollment.create({
        data: { userId: user.id, courseId: course.id, active: index === 0 },
      });
    }
    const response = await admin(request(app.getHttpServer()).get(base)).expect(
      200,
    );
    const rows = CourseListItemSchema.array().parse(response.body);
    expect(rows.find((row) => row.slug === slugs[0])).toMatchObject({
      hasDraft: true,
      published: false,
      latestPublishedVersion: null,
      lessonCount: 2,
      activeEnrollments: 1,
    });
    expect(rows.find((row) => row.slug === slugs[1])).toMatchObject({
      lessonCount: 0,
      activeEnrollments: 0,
    });
    expect(rows.map((row) => row.title)).toEqual(
      [...rows.map((row) => row.title)].sort(),
    );
  });

  it('lists only owned assets, newest first, using the stored public URL', async () => {
    const courses = await prisma.course.findMany({
      where: { slug: { in: slugs } },
    });
    for (const course of courses) {
      for (const day of [1, 2]) {
        await prisma.courseAsset.create({
          data: {
            courseId: course.id,
            type: 'image',
            objectKey: `https://assets.example.com/${course.slug}/${day}.png`,
            mimeType: 'image/png',
            createdAt: new Date(`2026-01-0${day}`),
          },
        });
      }
    }
    const response = await admin(
      request(app.getHttpServer()).get(path('/assets')),
    ).expect(200);
    const assets = CourseAssetSchema.array().parse(response.body);
    expect(assets).toHaveLength(2);
    expect(assets.map((asset) => asset.url)).toEqual(
      [2, 1].map((day) => `https://assets.example.com/${slugs[0]}/${day}.png`),
    );
    await admin(
      request(app.getHttpServer()).get(path('/assets', `absent-${stamp}`)),
    ).expect(404);
  });

  it('creates a scoped assessment from an empty lesson and records its audit atomically', async () => {
    const response = await admin(
      request(app.getHttpServer())
        .post(path('/draft/lessons/one/assessments'))
        .send({ type: 'quiz', question: 'Question?' }),
    ).expect(201);
    const draft = DraftSummarySchema.parse(response.body);
    const assessment = draft.modules[0].lessons[0].assessments[0];
    expect(assessment).toMatchObject({
      type: 'quiz',
      question: 'Question?',
      options: [],
      clientCriteria: [],
      expectedResult: null,
      successCriteria: [],
      commonFailures: [],
    });
    expect(response.body.modules[0].lessons[0]).not.toHaveProperty('content');
    const audit = await prisma.auditEvent.findFirst({
      where: { targetId: draft.id, action: 'admin.draft.createAssessment' },
    });
    expect(audit?.success).toBe(true);
    await admin(
      request(app.getHttpServer())
        .post(path('/draft/lessons/one/assessments', slugs[1]))
        .send({ type: 'quiz', question: 'Wrong course' }),
    ).expect(404);
    await admin(
      request(app.getHttpServer())
        .post(path('/draft/lessons/one/assessments'))
        .send({ question: 'Missing type' }),
    ).expect(400);
    await admin(
      request(app.getHttpServer())
        .patch(path(`/draft/assessments/${assessment.id}`, slugs[1]))
        .send({ question: 'Wrong course' }),
    ).expect(404);
    const get = await admin(
      request(app.getHttpServer()).get(path('/draft')),
    ).expect(200);
    expect(
      DraftVersionSchema.parse(get.body).modules[0].lessons[0].content,
    ).toEqual(validContent);
  });

  it('returns all publish issues with stable lesson and block locations, even with identical titles', async () => {
    for (const contentId of ['one', 'two']) {
      const blocks = Array.from({ length: 20 }, (_, index) => ({
        id: `image-${index}`,
        type: 'image',
        props: { assetId: `foreign-${index}` },
      }));
      await admin(
        request(app.getHttpServer())
          .patch(path(`/draft/lessons/${contentId}`))
          .send({ content: { schemaVersion: 1, blocks } }),
      ).expect(200);
    }
    const response = await admin(
      request(app.getHttpServer()).post(path('/publish')).send({}),
    ).expect(422);
    const error = PublishErrorSchema.parse(response.body);
    expect(error.problems).toEqual(error.issues.map((issue) => issue.message));
    expect(error.issues.length).toBeGreaterThanOrEqual(40);
    for (const contentId of ['one', 'two']) {
      expect(error.issues).toContainEqual(
        expect.objectContaining({ moduleId, contentId, blockId: 'image-19' }),
      );
    }
    const empty = await admin(
      request(app.getHttpServer()).post(path('/publish', slugs[1])).send({}),
    ).expect(422);
    expect(PublishErrorSchema.parse(empty.body).issues).toContainEqual({
      message: '首次发布的课程至少需要一个模块',
    });
  });

  it('publishes valid content and chooses the newer draft for list counts', async () => {
    for (const contentId of ['one', 'two']) {
      await admin(
        request(app.getHttpServer())
          .patch(path(`/draft/lessons/${contentId}`))
          .send({ content: validContent }),
      ).expect(200);
    }
    await admin(
      request(app.getHttpServer()).post(path('/publish')).send({}),
    ).expect(201);
    let rows = CourseListItemSchema.array().parse(
      (await admin(request(app.getHttpServer()).get(base)).expect(200)).body,
    );
    expect(rows.find((row) => row.slug === slugs[0])).toMatchObject({
      published: true,
      latestPublishedVersion: 1,
      hasDraft: false,
      lessonCount: 2,
    });
    await admin(request(app.getHttpServer()).post(path('/draft'))).expect(201);
    await admin(
      request(app.getHttpServer()).delete(path('/draft/lessons/two')),
    ).expect(200);
    rows = CourseListItemSchema.array().parse(
      (await admin(request(app.getHttpServer()).get(base)).expect(200)).body,
    );
    expect(rows.find((row) => row.slug === slugs[0])).toMatchObject({
      latestPublishedVersion: 1,
      hasDraft: true,
      lessonCount: 1,
    });
  });

  it('reads effective metadata without changing sparse overrides and preserves it through publish', async () => {
    const metadata = {
      shortTitle: 'Rich',
      category: 'Technology',
      description: 'Existing description',
      level: 'ADVANCED' as const,
      language: 'zh',
      tags: ['linux'],
      outcomes: ['Configure a server'],
      requirements: ['Terminal access'],
    };
    await prisma.course.update({ where: { slug: slugs[0] }, data: metadata });
    await admin(
      request(app.getHttpServer())
        .patch(path('/draft'))
        .send({ title: 'Renamed course' }),
    ).expect(200);
    const response = await admin(
      request(app.getHttpServer()).get(path('/draft')),
    ).expect(200);
    const draft = CourseDraftReadSchema.parse(response.body);
    expect(draft.meta).toEqual({ title: 'Renamed course' });
    expect(draft.effectiveMeta).toEqual({
      ...metadata,
      title: 'Renamed course',
      level: 'Advanced',
    });
    await admin(
      request(app.getHttpServer())
        .patch(path('/draft'))
        .send(draft.effectiveMeta),
    ).expect(200);
    await admin(
      request(app.getHttpServer()).post(path('/publish')).send({}),
    ).expect(201);
    const published = await prisma.course.findUniqueOrThrow({
      where: { slug: slugs[0] },
    });
    expect(published).toMatchObject({ ...metadata, title: 'Renamed course' });
  });

  it('rolls assessment creation back when its audit fails', async () => {
    await admin(request(app.getHttpServer()).post(path('/draft'))).expect(201);
    const draft = await prisma.courseVersion.findFirstOrThrow({
      where: { course: { slug: slugs[0] }, publishedAt: null },
    });
    const where = { lesson: { module: { courseVersionId: draft.id } } };
    const before = await prisma.lessonAssessment.count({ where });
    const audit = jest
      .spyOn(app.get(AuditService), 'record')
      .mockRejectedValueOnce(new Error('expected audit failure'));
    try {
      await admin(
        request(app.getHttpServer())
          .post(path('/draft/lessons/one/assessments'))
          .send({ type: 'quiz', question: 'Must roll back' }),
      ).expect(500);
    } finally {
      audit.mockRestore();
    }
    expect(await prisma.lessonAssessment.count({ where })).toBe(before);
    expect(
      await prisma.lessonAssessment.count({
        where: { ...where, question: 'Must roll back' },
      }),
    ).toBe(0);
  });
});
