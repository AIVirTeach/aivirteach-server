import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { signAccessToken } from '../src/auth/tokens';
import { CourseAssetStorageService } from '../src/courses/course-asset-storage.service';

// 需要 docker compose up -d 且已执行 prisma migrate（含 course_content_model_a）。
// 对象存储用桩（不碰真实 Vercel Blob）；其余全部走真库、真 Nest 管线。
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const STUB_URL = 'https://blob.example.test/courses/stub.png';

describe('课时块 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const adminToken = process.env.ADMIN_API_TOKEN ?? '';
  const jwtSecret = process.env.JWT_SECRET ?? '';
  const stamp = Date.now();
  const slug = `blocks-e2e-${stamp}`;
  const otherSlug = `blocks-e2e-other-${stamp}`;
  const email = `blocks-e2e-${stamp}@example.com`;
  let learnerToken: string;
  let moduleId: string;
  let assetId: string;

  const admin = (req: request.Test) =>
    req
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Operator', 'e2e@example.com');
  const learner = (req: request.Test) =>
    req.set('Authorization', `Bearer ${learnerToken}`);

  const imageLesson = (id: string) => ({
    schemaVersion: 1,
    blocks: [
      { id: 'b1', type: 'heading', props: { level: 2, text: '第一步' } },
      { id: 'b2', type: 'paragraph', props: { text: '看**图**。' } },
      { id: 'b3', type: 'image', props: { assetId: id, alt: '终端截图' } },
    ],
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CourseAssetStorageService)
      .useValue({ uploadBuffer: jest.fn().mockResolvedValue(STUB_URL) })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    const user = await prisma.user.create({ data: { email } });
    learnerToken = await signAccessToken(
      { sub: user.id, email },
      jwtSecret,
      '15m',
    );
  });

  afterAll(async () => {
    await prisma.course.deleteMany({
      where: { slug: { in: [slug, otherSlug] } },
    });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
    await app.close();
  });

  it('新建课程得到草稿；未发版前学员列表看不到、读课 404', async () => {
    const created = await admin(
      request(app.getHttpServer())
        .post('/api/v1/admin/courses')
        .send({ slug, title: '块测试课' }),
    ).expect(201);
    expect(created.body.publishedAt).toBeNull();

    const list = await learner(
      request(app.getHttpServer()).get('/api/v1/courses'),
    ).expect(200);
    expect((list.body as { id: string }[]).map((c) => c.id)).not.toContain(
      slug,
    );

    await learner(
      request(app.getHttpServer()).get(`/api/v1/courses/${slug}/lessons/intro`),
    ).expect(404);
  });

  it('加模块和课时，上传图片素材（存储为桩）', async () => {
    const mod = await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${slug}/draft/modules`)
        .send({ title: '模块一', description: '', estimatedMinutes: 10 }),
    ).expect(201);
    moduleId = (mod.body as { modules: { id: string }[] }).modules[0].id;

    await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${slug}/draft/modules/${moduleId}/lessons`)
        .send({
          contentId: 'intro',
          title: '入门',
          estimatedMinutes: 5,
          activity: { type: 'reading', prompt: '', completionType: 'manual' },
        }),
    ).expect(201);

    const uploaded = await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${slug}/assets`)
        .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
        .field('altText', '终端截图'),
    ).expect(201);
    assetId = (uploaded.body as { id: string }).id;
    expect(uploaded.body).toMatchObject({
      url: STUB_URL,
      mimeType: 'image/png',
    });
  });

  it('非法块发版 422，数据库保持草稿不变', async () => {
    await admin(
      request(app.getHttpServer())
        .patch(`/api/v1/admin/courses/${slug}/draft/lessons/intro`)
        .send({
          content: {
            schemaVersion: 1,
            blocks: [{ id: 'x', type: 'nope', props: {} }],
          },
        }),
    ).expect(200); // 草稿写入允许暂存非法块，发版才拦

    const publish = await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${slug}/publish`)
        .send({}),
    );
    expect(publish.status).toBe(422);
    expect(publish.body.problems.length).toBeGreaterThan(0);

    const version = await prisma.courseVersion.findFirstOrThrow({
      where: { course: { slug } },
    });
    expect(version.publishedAt).toBeNull();
    expect(
      (await prisma.course.findUniqueOrThrow({ where: { slug } })).published,
    ).toBe(false);
  });

  it('引用别的课程的素材发版被拒', async () => {
    await admin(
      request(app.getHttpServer())
        .post('/api/v1/admin/courses')
        .send({ slug: otherSlug, title: '另一门' }),
    ).expect(201);
    const foreign = await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${otherSlug}/assets`)
        .attach('file', PNG, { filename: 'b.png', contentType: 'image/png' }),
    ).expect(201);

    await admin(
      request(app.getHttpServer())
        .patch(`/api/v1/admin/courses/${slug}/draft/lessons/intro`)
        .send({ content: imageLesson((foreign.body as { id: string }).id) }),
    ).expect(200);

    const publish = await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${slug}/publish`)
        .send({}),
    );
    expect(publish.status).toBe(422);
    expect(JSON.stringify(publish.body.problems)).toContain('图片资源不存在');
  });

  it('草稿设置 level 后仍可发版，并映射到 Course.level', async () => {
    await admin(
      request(app.getHttpServer())
        .patch(`/api/v1/admin/courses/${slug}/draft`)
        .send({ level: 'Intermediate' }),
    ).expect(200);
  });

  it('正确的 image 块发版成功，学员读到 blocks 与 assets', async () => {
    await admin(
      request(app.getHttpServer())
        .patch(`/api/v1/admin/courses/${slug}/draft/lessons/intro`)
        .send({ content: imageLesson(assetId) }),
    ).expect(200);

    await admin(
      request(app.getHttpServer())
        .post(`/api/v1/admin/courses/${slug}/publish`)
        .send({}),
    ).expect(201);

    const list = await learner(
      request(app.getHttpServer()).get('/api/v1/courses'),
    ).expect(200);
    expect((list.body as { id: string }[]).map((c) => c.id)).toContain(slug);

    const lesson = await learner(
      request(app.getHttpServer()).get(`/api/v1/courses/${slug}/lessons/intro`),
    ).expect(200);
    expect(lesson.body.blocks).toEqual(imageLesson(assetId).blocks);
    expect(lesson.body.assets[assetId]).toMatchObject({ alt: '终端截图' });
    expect(typeof lesson.body.markdown).toBe('string');
    expect(
      (await prisma.course.findUniqueOrThrow({ where: { slug } })).level,
    ).toBe('INTERMEDIATE');
  });
});
