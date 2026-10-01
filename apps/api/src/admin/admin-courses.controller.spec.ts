import { Test } from '@nestjs/testing';
import { INestApplication, UnprocessableEntityException } from '@nestjs/common';
import request from 'supertest';
import { ENV, type Env } from '../config/env';
import { CourseDraftService } from './draft/course-draft.service';
import { DraftContentService } from './draft/draft-content.service';
import { CoursePublishService } from './course-publish.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminCoursesController } from './admin-courses.controller';

const TOKEN = 'a'.repeat(32);
const OPERATOR = 'editor@example.com';
const draft = { id: 'v2', courseId: 'course-1', modules: [] };
const problems = [{ code: 'empty', message: 'draft is empty' }];

describe('AdminCoursesController', () => {
  let app: INestApplication;
  const drafts = {
    createDraft: jest.fn(),
    discardDraft: jest.fn(),
    requireDraft: jest.fn(),
    updateCourse: jest.fn(),
    updateWelcome: jest.fn(),
  };
  const content = {
    createModule: jest.fn(),
    updateModule: jest.fn(),
    deleteModule: jest.fn(),
    createLesson: jest.fn(),
    updateLesson: jest.fn(),
    deleteLesson: jest.fn(),
    reorder: jest.fn(),
    updateAssessment: jest.fn(),
  };
  const publishing = { publish: jest.fn() };
  const prisma = { courseAsset: { findMany: jest.fn().mockResolvedValue([]) } };

  const routes: Array<{
    method: 'post' | 'delete' | 'patch' | 'put' | 'get';
    path: string;
    body?: unknown;
    service: jest.Mock;
    args?: unknown[];
  }> = [
    {
      method: 'post',
      path: '/admin/courses/demo/draft',
      service: drafts.createDraft,
      args: ['demo', OPERATOR],
    },
    {
      method: 'delete',
      path: '/admin/courses/demo/draft',
      service: drafts.discardDraft,
      args: ['demo', OPERATOR],
    },
    {
      method: 'patch',
      path: '/admin/courses/demo/draft',
      body: { title: 'Title' },
      service: drafts.updateCourse,
      args: ['demo', { title: 'Title' }, OPERATOR],
    },
    {
      method: 'patch',
      path: '/admin/courses/demo/draft/welcome',
      body: { finalOutcome: 'Done' },
      service: drafts.updateWelcome,
      args: ['demo', { finalOutcome: 'Done' }, OPERATOR],
    },
    {
      method: 'post',
      path: '/admin/courses/demo/draft/modules',
      body: { title: 'M', description: '', estimatedMinutes: 1 },
      service: content.createModule,
      args: [
        'demo',
        { title: 'M', description: '', estimatedMinutes: 1 },
        OPERATOR,
      ],
    },
    {
      method: 'patch',
      path: '/admin/courses/demo/draft/modules/mod-1',
      body: { title: 'M2' },
      service: content.updateModule,
      args: ['demo', 'mod-1', { title: 'M2' }, OPERATOR],
    },
    {
      method: 'delete',
      path: '/admin/courses/demo/draft/modules/mod-1',
      service: content.deleteModule,
      args: ['demo', 'mod-1', OPERATOR],
    },
    {
      method: 'post',
      path: '/admin/courses/demo/draft/modules/mod-1/lessons',
      body: {
        contentId: 'lesson-1',
        title: 'L',
        estimatedMinutes: 1,
        activity: { type: 'read', prompt: '', completionType: 'none' },
      },
      service: content.createLesson,
      args: [
        'demo',
        'mod-1',
        {
          contentId: 'lesson-1',
          title: 'L',
          estimatedMinutes: 1,
          activity: { type: 'read', prompt: '', completionType: 'none' },
        },
        OPERATOR,
      ],
    },
    {
      method: 'patch',
      path: '/admin/courses/demo/draft/lessons/lesson-1',
      body: { title: 'L2' },
      service: content.updateLesson,
      args: ['demo', 'lesson-1', { title: 'L2' }, OPERATOR],
    },
    {
      method: 'delete',
      path: '/admin/courses/demo/draft/lessons/lesson-1',
      service: content.deleteLesson,
      args: ['demo', 'lesson-1', OPERATOR],
    },
    {
      method: 'put',
      path: '/admin/courses/demo/draft/order',
      body: { modules: [] },
      service: content.reorder,
      args: ['demo', { modules: [] }, OPERATOR],
    },
    {
      method: 'patch',
      path: '/admin/courses/demo/draft/assessments/a-1',
      body: { question: 'Q' },
      service: content.updateAssessment,
      args: ['demo', 'a-1', { question: 'Q' }, OPERATOR],
    },
    {
      method: 'post',
      path: '/admin/courses/demo/publish',
      body: { reason: 'approved' },
      service: publishing.publish,
      args: ['demo', OPERATOR, 'approved'],
    },
  ];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminCoursesController],
      providers: [
        { provide: ENV, useValue: { ADMIN_API_TOKEN: TOKEN } as Env },
        { provide: CourseDraftService, useValue: drafts },
        { provide: DraftContentService, useValue: content },
        { provide: CoursePublishService, useValue: publishing },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    drafts.createDraft.mockResolvedValue({ draft, created: true });
    drafts.requireDraft.mockResolvedValue(draft);
    prisma.courseAsset.findMany.mockResolvedValue([]);
    for (const route of routes) route.service.mockResolvedValue(draft);
    drafts.createDraft.mockResolvedValue({ draft, created: true });
  });

  it.each(routes)('$method $path requires the admin token', async (route) => {
    const response = await request(app.getHttpServer())
      [route.method](route.path)
      .set('X-Operator', OPERATOR)
      .send(route.body);
    expect(response.status).toBe(401);
    const wrong = await request(app.getHttpServer())
      [route.method](route.path)
      .set('Authorization', `Bearer ${'z'.repeat(32)}`)
      .set('X-Operator', OPERATOR)
      .send(route.body);
    expect(wrong.status).toBe(401);
  });

  it.each(routes)(
    '$method $path validates operator and delegates',
    async (route) => {
      let call = request(app.getHttpServer())
        [route.method](route.path)
        .set('Authorization', `Bearer ${TOKEN}`);
      if (route.method !== 'get')
        call = call.set('X-Operator', OPERATOR).send(route.body);
      const response = await call;
      expect(response.status).toBe(route.method === 'post' ? 201 : 200);
      if (route.args) expect(route.service).toHaveBeenCalledWith(...route.args);
    },
  );

  it('returns 400 when X-Operator is absent or invalid', async () => {
    const absent = await request(app.getHttpServer())
      .post('/admin/courses/demo/draft')
      .set('Authorization', `Bearer ${TOKEN}`);
    const invalid = await request(app.getHttpServer())
      .post('/admin/courses/demo/draft')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Operator', 'not-email');
    expect(absent.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(drafts.createDraft).not.toHaveBeenCalled();
  });

  it('returns 201 for created draft and 200 when draft already existed', async () => {
    const post = () =>
      request(app.getHttpServer())
        .post('/admin/courses/demo/draft')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('X-Operator', OPERATOR);
    expect((await post()).status).toBe(201);
    drafts.createDraft.mockResolvedValueOnce({ draft, created: false });
    expect((await post()).status).toBe(200);
  });

  it('returns the learner-shaped preview and 404 for unknown content', async () => {
    const lesson = {
      id: 'db-1',
      contentId: 'lesson-1',
      position: 1,
      title: 'Lesson',
      estimatedMinutes: 2,
      objectives: [],
      activityType: 'read',
      activityPrompt: '',
      activityCompletionType: 'none',
      body: 'markdown',
      content: { schemaVersion: 1, blocks: [] },
    };
    const module = {
      id: 'module-1',
      position: 1,
      title: 'Module',
      lessons: [lesson],
    };
    drafts.requireDraft.mockResolvedValue({ ...draft, modules: [module] });
    const response = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft/lessons/lesson-1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      courseId: 'demo',
      lesson: { id: 'lesson-1' },
      markdown: 'markdown',
      blocks: [],
    });
    const missing = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft/lessons/missing')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(missing.status).toBe(404);
  });

  it('protects draft preview with the admin token', async () => {
    const withoutToken = await request(app.getHttpServer()).get(
      '/admin/courses/demo/draft/lessons/lesson-1',
    );
    const wrongToken = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft/lessons/lesson-1')
      .set('Authorization', `Bearer ${'z'.repeat(32)}`);
    expect(withoutToken.status).toBe(401);
    expect(wrongToken.status).toBe(401);
    expect(drafts.requireDraft).not.toHaveBeenCalled();
  });

  it('returns complete publish validation problems', async () => {
    publishing.publish.mockRejectedValue(
      new UnprocessableEntityException({ message: '草稿校验未通过', problems }),
    );
    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/publish')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Operator', OPERATOR)
      .send({ reason: 'approved' });
    expect(response.status).toBe(422);
    expect(response.body.problems).toEqual(problems);
  });
});
