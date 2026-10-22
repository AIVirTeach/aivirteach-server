import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import path from 'node:path';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://aivirteach@127.0.0.1:55439/aivirteach_4b';
const database = new URL(databaseUrl);
if (database.hostname !== '127.0.0.1' || database.pathname !== '/aivirteach_4b')
  throw new Error('Dedicated local database required');
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const api = process.env.API_E2E_URL ?? 'http://127.0.0.1:4400/api/v1';
const password = 'Local-editor-password-2026';
const email = 'editor-e2e@example.com';
const slug = `browser-course-${Date.now()}`;
test.afterAll(async () => prisma.$disconnect());

test('operator authors, previews, reloads and publishes a course', async ({
  page,
  request,
}) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/courses$/);
  await page.getByRole('button', { name: '新建课程', exact: true }).click();
  await page.getByLabel('课程名称', { exact: true }).fill('浏览器端到端课程');
  await page.getByLabel('课程标识', { exact: false }).fill(slug);
  await page.getByRole('button', { name: '创建课程', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${slug}$`));
  await page.getByLabel('模块名称', { exact: true }).fill('第一模块');
  await page.getByRole('button', { name: '创建模块', exact: true }).click();
  await expect(page.getByRole('heading', { name: /第一模块/ })).toBeVisible();
  await page.getByText('＋ 添加课时', { exact: true }).click();
  await page.getByLabel('课时名称', { exact: true }).fill('第一课');
  await page.getByLabel('课时标识', { exact: true }).fill('first-lesson');
  await page.getByRole('button', { name: '创建课时', exact: true }).click();
  await page.getByRole('link', { name: /第一课/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/courses/${slug}/lessons/first-lesson$`),
  );
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page
    .getByLabel('文字', { exact: true })
    .fill('这是浏览器保存并发布的课程正文。');
  await expect(
    page.getByRole('status').filter({ hasText: /^已保存$/ }),
  ).toBeVisible();
  await page.getByLabel('内容类型', { exact: true }).selectOption('image');
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page
    .getByLabel('上传图片', { exact: true })
    .setInputFiles(
      path.resolve('apps/api/src/courses/__fixtures__/sample-course/cover.png'),
    );
  await expect(page.getByLabel('课程图片', { exact: true })).not.toHaveValue(
    '',
  );
  await expect(
    page.getByRole('status').filter({ hasText: /^已保存$/ }),
  ).toBeVisible();
  const preview = page.frameLocator('iframe[title="真实课时预览"]');
  await expect(
    preview.getByText('这是浏览器保存并发布的课程正文。', { exact: true }),
  ).toBeVisible();
  await expect(preview.locator('img')).toHaveCount(1);
  await expect
    .poll(() =>
      preview
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByText('＋ 添加测评', { exact: true }).click();
  await page.getByLabel('题干', { exact: true }).fill('这一课学到了什么？');
  await page.getByRole('button', { name: '创建测评', exact: true }).click();
  await expect(page.getByText(/测评 1 · 这一课学到了什么/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('课时测评', { exact: true })).toBeVisible();
  await expect(
    preview.getByText('这是浏览器保存并发布的课程正文。', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/course-editor-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: '第一课', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: 'test-results/course-editor-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: '← 返回课程', exact: true }).click();
  await page.getByRole('button', { name: '发布课程', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认发布' })
    .click();
  await expect(page.getByText('当前没有草稿', { exact: true })).toBeVisible();
  const secret =
    process.env.JWT_SECRET ?? 'local-admin-editor-test-secret-32-characters';
  const token = await new SignJWT({ email: 'learner-e2e@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('local-learner')
    .setAudience('aivirteach-client')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
  const response = await request.get(
    `${api}/courses/${slug}/lessons/first-lesson`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(response.status()).toBe(200);
  const lesson = await response.json();
  expect(lesson.blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'paragraph',
        props: expect.objectContaining({
          text: '这是浏览器保存并发布的课程正文。',
        }),
      }),
    ]),
  );
  expect(Object.keys(lesson.assets)).toHaveLength(1);
  const course = await prisma.course.findUniqueOrThrow({
    where: { slug },
    include: {
      versions: {
        include: {
          modules: { include: { lessons: { include: { assessments: true } } } },
        },
      },
    },
  });
  expect(course.versions[0].modules[0].lessons[0].assessments[0].question).toBe(
    '这一课学到了什么？',
  );
  const audit = await prisma.auditEvent.findFirst({
    where: {
      action: 'admin.publishCourse',
      actorId: email,
      targetId: course.versions[0].id,
    },
  });
  expect(audit).toMatchObject({ actorType: 'OPERATOR', success: true });
  await page.getByRole('button', { name: '创建草稿', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '发布课程', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
