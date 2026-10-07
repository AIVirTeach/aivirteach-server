import { Test } from '@nestjs/testing';
import {
  type ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import request from 'supertest';
import { OperatorAuthGuard } from '../operator-auth/operator-auth.guard';
import { CourseDraftService } from './draft/course-draft.service';
import { DraftContentService } from './draft/draft-content.service';
import { CoursePublishService } from './course-publish.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminCourseCreateController,
  AdminCoursesController,
} from './admin-courses.controller';
import { CourseCreateService } from './draft/course-create.service';
import { CourseAssetUploadService } from './assets/course-asset-upload.service';

const TOKEN = 'a'.repeat(32);
const OPERATOR = 'editor@example.com';
// 真正的守卫在 operator-auth.guard.spec 里测；这里只关心控制器拿到守卫放行后的身份。
const stubGuard = {
  canActivate: (context: ExecutionContext) => {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      operator?: { id: string; email: string };
    }>();
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      throw new UnauthorizedException();
    }
    req.operator = { id: 'op_1', email: OPERATOR };
    return true;
  },
};
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
  const courseCreation = { create: jest.fn() };
  const assetUploads = { upload: jest.fn() };
  const prisma = { courseAsset: { findMany: jest.fn().mockResolvedValue([]) } };

  const routes: Array<{
    method: 'post' | 'delete' | 'patch' | 'put' | 'get';
    path: string;
    body?: Record<string, unknown>;
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
      method: 'get',
      path: '/admin/courses/demo/draft',
      service: drafts.requireDraft,
      args: ['demo'],
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
      controllers: [AdminCoursesController, AdminCourseCreateController],
      providers: [
        { provide: CourseDraftService, useValue: drafts },
        { provide: DraftContentService, useValue: content },
        { provide: CoursePublishService, useValue: publishing },
        { provide: CourseCreateService, useValue: courseCreation },
        { provide: CourseAssetUploadService, useValue: assetUploads },
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .overrideGuard(OperatorAuthGuard)
      .useValue(stubGuard)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    drafts.createDraft.mockResolvedValue({ draft, created: true });
    courseCreation.create.mockResolvedValue(draft);
    assetUploads.upload.mockResolvedValue({
      id: 'asset-1',
      url: 'https://blob.test/a.png',
      altText: null,
      mimeType: 'image/png',
    });
    drafts.requireDraft.mockResolvedValue(draft);
    prisma.courseAsset.findMany.mockResolvedValue([]);
    for (const route of routes) route.service.mockResolvedValue(draft);
    drafts.createDraft.mockResolvedValue({ draft, created: true });
  });

  it('POST /admin/courses/:slug/assets requires a logged-in operator', async () => {
    const noToken = await request(app.getHttpServer())
      .post('/admin/courses/demo/assets')
      .attach(
        'file',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'anything.jpg',
      );
    expect(noToken.status).toBe(401);
  });

  it('POST /admin/courses/:slug/assets requires a file and delegates a normal upload', async () => {
    const missing = await request(app.getHttpServer())
      .post('/admin/courses/demo/assets')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('图片');

    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/assets')
      .set('Authorization', `Bearer ${TOKEN}`)
      .field('altText', 'A diagram')
      .attach(
        'file',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'untrusted.jpg',
      );
    expect(response.status).toBe(201);
    expect(assetUploads.upload).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ size: 8, buffer: expect.any(Buffer) }),
      'A diagram',
      OPERATOR,
    );
    expect(response.body).toEqual({
      id: 'asset-1',
      url: 'https://blob.test/a.png',
      altText: null,
      mimeType: 'image/png',
    });
  });

  it('POST /admin/courses/:slug/assets rejects a repeated altText field instead of failing later', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/assets')
      .set('Authorization', `Bearer ${TOKEN}`)
      .field('altText', 'one')
      .field('altText', 'two')
      .attach(
        'file',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'a.png',
      );
    expect(response.status).toBe(400);
    expect(assetUploads.upload).not.toHaveBeenCalled();
  });

  it('POST /admin/courses/:slug/assets rejects altText over 300 characters', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/assets')
      .set('Authorization', `Bearer ${TOKEN}`)
      .field('altText', 'x'.repeat(301))
      .attach(
        'file',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'a.png',
      );
    expect(response.status).toBe(400);
    expect(assetUploads.upload).not.toHaveBeenCalled();
  });

  it('POST /admin/courses/:slug/assets maps file-size overflow to Chinese 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/assets')
      .set('Authorization', `Bearer ${TOKEN}`)
      .attach(
        'file',
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(5 * 1024 * 1024),
        ]),
        'large.png',
      );
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('5 MiB');
    expect(assetUploads.upload).not.toHaveBeenCalled();
  });

  it.each(routes)('$method $path requires the admin token', async (route) => {
    const response = await request(app.getHttpServer())
      [route.method](route.path)
      .send(route.body);
    expect(response.status).toBe(401);
    const wrong = await request(app.getHttpServer())
      [route.method](route.path)
      .set('Authorization', `Bearer ${'z'.repeat(32)}`)
      .send(route.body);
    expect(wrong.status).toBe(401);
  });

  it.each(routes)(
    '$method $path validates operator and delegates',
    async (route) => {
      let call = request(app.getHttpServer())
        [route.method](route.path)
        .set('Authorization', `Bearer ${TOKEN}`);
      if (route.method !== 'get') call = call.send(route.body);
      const response = await call;
      expect(response.status).toBe(route.method === 'post' ? 201 : 200);
      if (route.args) expect(route.service).toHaveBeenCalledWith(...route.args);
    },
  );

  it('ignores a self-reported X-Operator header: identity comes from the login', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/draft')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Operator', 'attacker@example.com');

    expect(response.status).toBe(201);
    expect(drafts.createDraft).toHaveBeenCalledWith('demo', OPERATOR);
  });

  it('creates a course at POST /admin/courses for the logged-in operator', async () => {
    const missingToken = await request(app.getHttpServer())
      .post('/admin/courses')
      .send({ slug: 'demo-course', title: 'Demo' });
    expect(missingToken.status).toBe(401);
    const response = await request(app.getHttpServer())
      .post('/admin/courses')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ slug: 'demo-course', title: 'Demo' });
    expect(response.status).toBe(201);
    expect(courseCreation.create).toHaveBeenCalledWith(
      { slug: 'demo-course', title: 'Demo' },
      OPERATOR,
    );
  });

  it('GET draft returns 404 when there is no draft', async () => {
    drafts.requireDraft.mockRejectedValueOnce(new NotFoundException());
    const response = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(response.status).toBe(404);
  });

  it('returns 201 for created draft and 200 when draft already existed', async () => {
    const post = () =>
      request(app.getHttpServer())
        .post('/admin/courses/demo/draft')
        .set('Authorization', `Bearer ${TOKEN}`);
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
    expect(prisma.courseAsset.findMany).not.toHaveBeenCalled();
    const missing = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft/lessons/missing')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(missing.status).toBe(404);
  });

  it('loads only referenced image assets for preview', async () => {
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
      content: {
        schemaVersion: 1,
        blocks: [
          {
            id: 'image-1',
            type: 'image',
            props: { assetId: 'asset-1', alt: 'Diagram' },
          },
        ],
      },
    };
    drafts.requireDraft.mockResolvedValue({
      ...draft,
      modules: [
        { id: 'module-1', position: 1, title: 'Module', lessons: [lesson] },
      ],
    });
    prisma.courseAsset.findMany.mockResolvedValue([
      { id: 'asset-1', objectKey: 'course/image.png', altText: 'Diagram' },
    ]);

    const response = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft/lessons/lesson-1')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(prisma.courseAsset.findMany).toHaveBeenCalledWith({
      where: { courseId: 'course-1', id: { in: ['asset-1'] } },
    });
    expect(response.body.assets).toEqual({
      'asset-1': { url: 'course/image.png', alt: 'Diagram' },
    });
  });

  it('returns 409 when contentId matches lessons in multiple modules', async () => {
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
      body: '',
      content: { schemaVersion: 1, blocks: [] },
    };
    drafts.requireDraft.mockResolvedValue({
      ...draft,
      modules: [
        { id: 'module-1', position: 1, title: 'One', lessons: [lesson] },
        {
          id: 'module-2',
          position: 2,
          title: 'Two',
          lessons: [{ ...lesson, id: 'db-2' }],
        },
      ],
    });

    const response = await request(app.getHttpServer())
      .get('/admin/courses/demo/draft/lessons/lesson-1')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(409);
    expect(prisma.courseAsset.findMany).not.toHaveBeenCalled();
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
      .send({ reason: 'approved' });
    expect(response.status).toBe(422);
    expect(response.body.problems).toEqual(problems);
  });

  it('publishes with the default reason when the request has no body', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/courses/demo/publish')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(201);
    expect(publishing.publish).toHaveBeenCalledWith(
      'demo',
      OPERATOR,
      'admin publish',
    );
  });
});
