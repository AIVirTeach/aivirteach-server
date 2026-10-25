import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = fileURLToPath(new URL('../', import.meta.url));
const database = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.equal(
  database.hostname,
  '127.0.0.1',
  'Use an explicit local test database',
);
assert.equal(
  database.pathname,
  '/aivirteach_learning_state',
  'Use the dedicated integration database',
);
const prisma = new PrismaClient();
const directory = await mkdtemp(
  path.join(tmpdir(), 'content-import-rejection-'),
);
const counts = () =>
  Promise.all([
    prisma.course.count(),
    prisma.courseVersion.count(),
    prisma.courseLesson.count(),
    prisma.auditEvent.count(),
  ]);
try {
  const manifest = JSON.parse(
    await readFile(
      path.join(
        root,
        'apps/api/src/courses/__fixtures__/sample-course/course.json',
      ),
      'utf8',
    ),
  );
  manifest.id = manifest.slug = `rejected-import-${Date.now()}`;
  for (const module of manifest.modules) {
    for (const lesson of module.lessons)
      lesson.sourceRange = { startLine: 1, endLine: 1 };
  }
  await writeFile(
    path.join(directory, 'course.json'),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(directory, 'lesson-source.md'),
    `## ${'x'.repeat(201)}`,
  );
  const before = await counts();
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'apps/api/dist/cli.js'),
      'course:create',
      directory,
      '--operator',
      'content-verification@example.com',
      '--reason',
      'Verify conversion rejection',
      '--execute',
    ],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, `Expected exit 1, received ${result.status}`);
  const reportLine = result.stderr
    .split('\n')
    .find((line) => line.startsWith('{"command":"course:create"'));
  assert.ok(reportLine, 'CLI must print the structured conversion report');
  const report = JSON.parse(reportLine);
  assert.equal(report.success, false);
  assert.deepEqual(
    report.conversionReports.map(({ lessonContentId }) => lessonContentId),
    ['lesson-1', 'lesson-2'],
  );
  assert.ok(
    report.conversionReports.every(({ issues }) =>
      issues.some(({ level }) => level === 'error'),
    ),
  );
  assert.deepEqual(
    await counts(),
    before,
    'Rejected imports must not create courses, versions, lessons, or audit records',
  );
  console.log(
    JSON.stringify({
      exitCode: result.status,
      conversionReports: report.conversionReports.length,
      databaseUnchanged: true,
    }),
  );
} finally {
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
}
