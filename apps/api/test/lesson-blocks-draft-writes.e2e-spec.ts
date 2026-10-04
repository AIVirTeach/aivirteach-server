import 'dotenv/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureBodyParsers } from '../src/body-parsers';

// 需要 docker compose up -d 且已执行 prisma migrate。验证两件只有真库才看得出来的事：
// 草稿写入加锁后重读（并发创建/删除不会留下断号）、发版时学员进度的重映射。
describe('草稿写入与发版（真库）', () => {
  let app: NestExpressApplication;
  const prisma = new PrismaClient();
  const adminToken = process.env.ADMIN_API_TOKEN ?? '';
  const stamp = Date.now();
  const slugs = [`draft-writes-${stamp}`, `draft-remap-${stamp}`];
  const email = `draft-remap-${stamp}@example.com`;

  const admin = (req: request.Test) =>
    req
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Operator', 'e2e@example.com');
  const api = (slug: string, path = '') =>
    `/api/v1/admin/courses/${slug}${path}`;
  const paragraph = {
    schemaVersion: 1,
    blocks: [{ id: 'p', type: 'paragraph', props: { text: '内容' } }],
  };
  const addModule = async (slug: string, title: string) => {
    const res = await admin(
      request(app.getHttpServer())
        .post(api(slug, '/draft/modules'))
        .send({ title, description: '', estimatedMinutes: 5 }),
    ).expect(201);
    return (
      res.body as { modules: { id: string; title: string }[] }
    ).modules.find((m) => m.title === title)!.id;
  };
  const lessonBody = (contentId: string) => ({
    contentId,
    title: contentId,
    estimatedMinutes: 1,
    content: paragraph,
    activity: { type: 'reading', prompt: '', completionType: 'manual' },
  });
  const addLesson = (slug: string, moduleId: string, contentId: string) =>
    admin(
      request(app.getHttpServer())
        .post(api(slug, `/draft/modules/${moduleId}/lessons`))
        .send(lessonBody(contentId)),
    );

  beforeAll(async () => {
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
        request(app.getHttpServer())
          .post('/api/v1/admin/courses')
          .send({ slug, title: slug }),
      ).expect(201);
    }
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { slug: { in: slugs } } });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
    await app.close();
  });

  it('并发删除课时与新建课时后，序号仍然连续', async () => {
    const slug = slugs[0];
    const moduleId = await addModule(slug, '模块一');
    const alive = ['a', 'b', 'c'];
    for (const id of alive) await addLesson(slug, moduleId, id).expect(201);

    for (let round = 0; round < 5; round += 1) {
      const removed = alive.shift()!;
      const created = `n${round}`;
      alive.push(created);
      const [del, add] = await Promise.all([
        admin(
          request(app.getHttpServer()).delete(
            api(slug, `/draft/lessons/${removed}`),
          ),
        ),
        addLesson(slug, moduleId, created),
      ]);
      expect([200, 204]).toContain(del.status);
      expect(add.status).toBe(201);

      const rows = await prisma.courseLesson.findMany({
        where: { moduleId },
        orderBy: { position: 'asc' },
        select: { position: true },
      });
      expect(rows.map((row) => row.position)).toEqual(
        rows.map((_, index) => index + 1),
      );
    }
  });

  it('并发删除模块与新建模块后，模块序号仍然连续', async () => {
    const slug = slugs[0];
    const first = await addModule(slug, '待删模块');
    await addModule(slug, '保留模块');
    const [del, add] = await Promise.all([
      admin(
        request(app.getHttpServer()).delete(
          api(slug, `/draft/modules/${first}`),
        ),
      ),
      admin(
        request(app.getHttpServer())
          .post(api(slug, '/draft/modules'))
          .send({ title: '并发新增', description: '', estimatedMinutes: 1 }),
      ),
    ]);
    expect([200, 204]).toContain(del.status);
    expect(add.status).toBe(201);

    const version = await prisma.courseVersion.findFirstOrThrow({
      where: { course: { slug } },
      select: { id: true },
    });
    const rows = await prisma.courseModule.findMany({
      where: { courseVersionId: version.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(rows.map((row) => row.position)).toEqual(
      rows.map((_, index) => index + 1),
    );
  });

  it('写接口返回不含课时正文的摘要，GET draft 仍带完整内容', async () => {
    const slug = slugs[0];
    const moduleId = (
      await prisma.courseModule.findFirstOrThrow({
        where: { courseVersion: { course: { slug } }, title: '保留模块' },
      })
    ).id;
    const res = await addLesson(slug, moduleId, 'summary-check').expect(201);
    const written = (
      res.body as {
        draft: { modules: { lessons: Record<string, unknown>[] }[] };
      }
    ).draft.modules.flatMap((m) => m.lessons);
    expect(written.length).toBeGreaterThan(0);
    for (const lesson of written) {
      expect(lesson).not.toHaveProperty('content');
      expect(lesson).not.toHaveProperty('body');
    }

    const full = await admin(
      request(app.getHttpServer()).get(api(slug, '/draft')),
    ).expect(200);
    const fullLessons = (
      full.body as { modules: { lessons: Record<string, unknown>[] }[] }
    ).modules.flatMap((m) => m.lessons);
    expect(fullLessons.every((lesson) => 'content' in lesson)).toBe(true);
  });

  it('发版时删除了学员所在课时，进度在同一事务里改指到下一个保留课时', async () => {
    const slug = slugs[1];
    const moduleId = await addModule(slug, '模块一');
    for (const id of ['lesson-a', 'lesson-b', 'lesson-c']) {
      await addLesson(slug, moduleId, id).expect(201);
    }
    await admin(
      request(app.getHttpServer()).post(api(slug, '/publish')).send({}),
    ).expect(201);

    const course = await prisma.course.findUniqueOrThrow({ where: { slug } });
    const user = await prisma.user.create({ data: { email } });
    const enrollment = await prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id },
    });
    await prisma.progress.create({
      data: { enrollmentId: enrollment.id, currentLessonContentId: 'lesson-b' },
    });

    await admin(request(app.getHttpServer()).post(api(slug, '/draft')).send());
    await admin(
      request(app.getHttpServer()).delete(api(slug, '/draft/lessons/lesson-b')),
    ).expect((res) => expect([200, 204]).toContain(res.status));
    await admin(
      request(app.getHttpServer()).post(api(slug, '/publish')).send({}),
    ).expect(201);

    const progress = await prisma.progress.findUniqueOrThrow({
      where: { enrollmentId: enrollment.id },
    });
    expect(progress.currentLessonContentId).toBe('lesson-c');
    const audits = await prisma.auditEvent.count({
      where: {
        action: 'admin.publishCourse',
        targetId: (
          await prisma.courseVersion.findFirstOrThrow({
            where: { courseId: course.id },
            orderBy: { version: 'desc' },
          })
        ).id,
      },
    });
    expect(audits).toBe(1);
  });
});
