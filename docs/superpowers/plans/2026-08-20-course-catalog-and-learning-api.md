# Course Catalog & Learning API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty-shell `course:create`/`course:publish` commands and the missing dashboard/courses/enrollment endpoints with a real implementation, so a logged-in learner actually sees course content, their enrollment, and dashboard stats instead of nothing.

**Architecture:** One Prisma schema migration (full Control Plane redesign) feeds three new NestJS feature modules (`courses`, `enrollments`, `dashboard`) plus a rewritten content-ingestion path used by the existing admin CLI. Course content is ingested once from a local `course.json` + markdown source directory at `course:create` time and served read-only afterward — server never re-reads Labs files on the request path. A final phase updates `aivirteach-client` to stop reading local mock data once these endpoints are live; that phase is explicitly gated and must not start early.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL, Zod 4, Jest 30, `nest-commander` (existing CLI framework).

## Global Constraints

- Design authority: `docs/superpowers/specs/2026-08-20-database-schema-design.md` (this plan implements it verbatim; if you find a mismatch, the spec wins — stop and reconcile before continuing).
- Follow existing patterns exactly: Zod schema + `ZodValidationPipe` for request validation (see `src/auth/auth.schemas.ts`, `src/auth/auth.controller.ts`), `JwtAuthGuard` + `AuthenticatedRequest` for authenticated routes (see `src/auth/jwt-auth.guard.ts`), Jest + `Test.createTestingModule` with hand-built Prisma stubs (see `src/admin/admin.service.spec.ts`) — do **not** hit a real database in unit tests.
- `PrismaService` and `AuditService` are `@Global()`/exported already — inject them directly, don't re-import their modules.
- Every mutating endpoint (enroll, restart, complete lesson, practice session, notifications read-all) is called by a **learner**, not an operator — audit as `AuditActorType.USER` with `actorId: request.auth.userId`, no `reason` required (that field is operator-only per the existing `AuditEvent.reason` comment).
- Any client-facing field that doubles as a URL route parameter (`ApiCourse.id`, `ApiEnrollment.courseId`, `ApiLesson.courseId`) is the course's **`slug`**, never the internal Prisma `Course.id` (cuid). The internal cuid never leaves the server. Get this wrong and every subsequent client request 404s.
- **Explicitly out of scope this round** (do not build, do not stub):
  - `POST /courses/:slug/lessons/:lessonId/assessment` — grading needs `assessments.json`, which does not exist in `aivirteach-labs` yet. Building a comparator now means inventing an ungrounded contract.
  - `GET /courses/:slug/assets/:assetId` (binary asset serving) — needs an object storage decision (S3/R2/MinIO) not made yet. `CourseAsset` rows are still ingested so this slots in later without a schema change.
  - `CourseWelcome` ingestion — `welcome.json` does not exist in any course yet; the table stays empty.
  - Console Session ticket issuance, Redis wiring, VM lifecycle orchestration (BullMQ → Labs `service.py`) — separate piece of work (SRV-011), not touched here.

---

## Part A — Server (aivirteach-server)

### Task 1: Replace the Prisma schema and reset the dev database

**Files:**
- Modify: `prisma/schema.prisma` (full replacement)
- Test: none (schema/migration tasks are verified by `prisma validate` + the later tasks' Prisma-client-typed code compiling)

**Interfaces:**
- Produces: every Prisma model/enum used by all later tasks — in particular `CourseModule`, `CourseLesson`, `CourseWelcome`, `LessonAssessment`, `EnrollmentCompletion`, `WorkspaceStatus.DESTROYED`, `Workspace.{labId,labsRawStatus,ip,rdpPort,rdpUsername,vncPort}`, `Progress.currentLessonId`, `Attempt.assessmentId`, `Course.{tags,outcomes,requirements}`.

- [ ] **Step 1: Replace `prisma/schema.prisma` with the full schema from the spec**

Copy the complete schema block from `docs/superpowers/specs/2026-08-20-database-schema-design.md` (section "完整 Prisma Schema", already amended with the `outcomes`/`requirements` and `LessonAssessment.options`/`clientCriteria` fixes) verbatim into `prisma/schema.prisma`, replacing the entire file.

- [ ] **Step 2: Validate the schema**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Reset the dev database and regenerate the client**

Run: `npm run db:up` (starts Postgres + Redis containers if not already running), then `npm run db:reset` (this is `prisma migrate reset --force` — it drops and recreates the dev DB, so it is safe here only because current dev data is disposable test accounts; do not run this against anything else).
Expected: migration named e.g. `20260820_full_control_plane_schema` created and applied, ends with `Your database is now in sync with your schema.` Prisma Client regenerates automatically as part of `migrate reset`.

- [ ] **Step 4: Re-seed a test operator invite so later manual testing works**

Run: `npm run cli -- invite ops@example.com -o ops@example.com -r "重新种测试账号" --execute`
Expected: prints an invitation token (note it down for manual testing later, not needed by any automated test).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): redesign Prisma schema for full Control Plane

Splits CourseVersion.content:Json into real Module/Lesson/Welcome/
Assessment tables, adds Workspace VM fields matching labs' real
service.py interface, adds EnrollmentCompletion, and converts
Progress/Attempt's raw int indexes into foreign keys. See
docs/superpowers/specs/2026-08-20-database-schema-design.md."
```

---

### Task 2: Course content ingestion (course.json → DB) + fix `course:publish`

**Files:**
- Create: `src/courses/course-content.schemas.ts`
- Create: `src/courses/course-content.schemas.spec.ts`
- Create: `src/courses/course-ingestion.service.ts`
- Create: `src/courses/course-ingestion.service.spec.ts`
- Create: `src/courses/courses.module.ts`
- Create: `src/courses/__fixtures__/sample-course/course.json`
- Create: `src/courses/__fixtures__/sample-course/lesson-source.md`
- Modify: `src/admin/admin.service.ts` (`createCourse`, `publishCourse`)
- Modify: `src/admin/admin.service.spec.ts`
- Modify: `src/admin/admin.module.ts` (import `CoursesModule`)
- Modify: `src/admin/commands/course.command.ts` (`CourseCreateCommand` interface change)
- Modify: `src/admin/commands/course.command.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (from `src/prisma/prisma.service.ts`), `AuditService.record` (from `src/audit/audit.service.ts`, unchanged signature).
- Produces: `CourseIngestionService.ingestFromDirectory(contentDir: string, imageDigest?: string): Promise<Course & { versions: CourseVersion[] }>`, exported from `CoursesModule`. `AdminService.createCourse(contentDir: string, operator: string, reason: string, imageDigest?: string): Promise<Course & { versions: CourseVersion[] }>` (signature changed: `slug`/`title` args removed, replaced by `contentDir`).

- [ ] **Step 1: Write the course.json Zod schema + level mapper, with a failing test**

Create `src/courses/course-content.schemas.spec.ts`:

```typescript
import { CourseContentSchema, mapCourseLevel } from './course-content.schemas';
import sampleCourse from './__fixtures__/sample-course/course.json';

describe('CourseContentSchema', () => {
  it('解析真实结构的 course.json 不报错', () => {
    expect(() => CourseContentSchema.parse(sampleCourse)).not.toThrow();
  });

  it('缺少 modules 时报错', () => {
    const { modules: _modules, ...broken } = sampleCourse as any;
    expect(() => CourseContentSchema.parse(broken)).toThrow();
  });
});

describe('mapCourseLevel', () => {
  it('大小写不敏感地映射到枚举', () => {
    expect(mapCourseLevel('Intermediate')).toBe('INTERMEDIATE');
    expect(mapCourseLevel('beginner')).toBe('BEGINNER');
    expect(mapCourseLevel('ADVANCED')).toBe('ADVANCED');
  });

  it('未知难度时报错', () => {
    expect(() => mapCourseLevel('Expert')).toThrow('未知的课程难度');
  });
});
```

Create the fixture `src/courses/__fixtures__/sample-course/course.json` (a trimmed-down real shape — one module, two lessons — mirroring `aivirteach-labs`'s real `course.json`):

```json
{
  "schemaVersion": 1,
  "id": "sample-course",
  "slug": "sample-course",
  "version": 1,
  "status": "published",
  "metadata": {
    "title": "Sample Course",
    "shortTitle": "Sample",
    "category": "Testing",
    "description": "A minimal course used only by ingestion tests.",
    "level": "Beginner",
    "durationMinutes": 30,
    "lessonCount": 2,
    "language": "en",
    "tags": ["testing"]
  },
  "outcomes": ["Understand the ingestion pipeline."],
  "requirements": ["None."],
  "source": {
    "format": "markdown",
    "path": "lesson-source.md",
    "encoding": "utf-8"
  },
  "assets": [
    { "id": "cover", "type": "image", "path": "cover.png", "alt": "Cover image" }
  ],
  "introduction": {
    "sourceRange": { "startLine": 1, "endLine": 2 },
    "featuredAssetIds": ["cover"]
  },
  "welcome": { "path": "welcome.json" },
  "modules": [
    {
      "id": "module-1",
      "position": 1,
      "title": "Module One",
      "description": "The only module.",
      "estimatedMinutes": 30,
      "lessons": [
        {
          "id": "lesson-1",
          "position": 1,
          "title": "Lesson One",
          "estimatedMinutes": 15,
          "sourceRange": { "startLine": 3, "endLine": 4 },
          "objectives": ["Read the first section."],
          "activity": { "type": "guided-lab", "prompt": "Read section one.", "completionType": "learner-confirmation" },
          "assessmentIds": ["check-lesson-1"]
        },
        {
          "id": "lesson-2",
          "position": 2,
          "title": "Lesson Two",
          "estimatedMinutes": 15,
          "sourceRange": { "startLine": 5, "endLine": 6 },
          "objectives": ["Read the second section."],
          "activity": { "type": "guided-lab", "prompt": "Read section two.", "completionType": "learner-confirmation" },
          "assessmentIds": ["check-lesson-2"]
        }
      ]
    }
  ],
  "assessments": { "path": "assessments.json", "delivery": "server-filtered" }
}
```

Create `src/courses/__fixtures__/sample-course/lesson-source.md`:

```markdown
# Intro

Welcome.

## Lesson One

Section one body.

## Lesson Two

Section two body.
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- course-content.schemas`
Expected: FAIL — `Cannot find module './course-content.schemas'`.

- [ ] **Step 3: Implement `course-content.schemas.ts`**

```typescript
import { z } from 'zod';

const SourceRangeSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const AssetSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1),
  alt: z.string().min(1),
});

const ActivitySchema = z.object({
  type: z.string().min(1),
  prompt: z.string().min(1),
  completionType: z.string().min(1),
});

const LessonSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().positive(),
  title: z.string().min(1),
  estimatedMinutes: z.number().int().nonnegative(),
  sourceRange: SourceRangeSchema,
  objectives: z.array(z.string().min(1)),
  activity: ActivitySchema,
  assessmentIds: z.array(z.string().min(1)),
});

const ModuleSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  estimatedMinutes: z.number().int().nonnegative(),
  lessons: z.array(LessonSchema).min(1),
});

export const CourseContentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  slug: z.string().min(1),
  version: z.number().int().positive(),
  status: z.string().min(1),
  metadata: z.object({
    title: z.string().min(1),
    shortTitle: z.string().min(1).optional(),
    category: z.string().min(1),
    description: z.string().min(1),
    level: z.string().min(1),
    durationMinutes: z.number().int().nonnegative(),
    lessonCount: z.number().int().nonnegative(),
    language: z.string().min(1),
    tags: z.array(z.string().min(1)),
  }),
  outcomes: z.array(z.string().min(1)),
  requirements: z.array(z.string().min(1)),
  source: z.object({
    format: z.string().min(1),
    path: z.string().min(1),
    encoding: z.string().min(1),
  }),
  assets: z.array(AssetSchema),
  introduction: z.object({
    sourceRange: SourceRangeSchema,
    featuredAssetIds: z.array(z.string().min(1)),
  }),
  welcome: z.object({ path: z.string().min(1) }),
  modules: z.array(ModuleSchema).min(1),
  assessments: z.object({
    path: z.string().min(1),
    delivery: z.string().min(1),
  }),
});

export type CourseContent = z.infer<typeof CourseContentSchema>;

type CourseLevelEnum = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

const LEVEL_MAP: Record<string, CourseLevelEnum> = {
  beginner: 'BEGINNER',
  intermediate: 'INTERMEDIATE',
  advanced: 'ADVANCED',
};

export function mapCourseLevel(level: string): CourseLevelEnum {
  const mapped = LEVEL_MAP[level.trim().toLowerCase()];
  if (!mapped) {
    throw new Error(
      `未知的课程难度："${level}"，course.json 的 metadata.level 只能是 Beginner/Intermediate/Advanced`,
    );
  }
  return mapped;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- course-content.schemas`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the ingestion service test (failing)**

Create `src/courses/course-ingestion.service.spec.ts`:

```typescript
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CourseIngestionService } from './course-ingestion.service';

const FIXTURE_DIR = join(__dirname, '__fixtures__', 'sample-course');

const buildPrisma = () => ({
  course: {
    create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'course_1', ...data, versions: [{ id: 'version_1', version: data.versions && (data.versions as any).create.version }] }),
    ),
  },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [CourseIngestionService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(CourseIngestionService);
};

describe('CourseIngestionService.ingestFromDirectory', () => {
  it('读 course.json + 源文件，拼出完整的嵌套 Prisma create', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.ingestFromDirectory(FIXTURE_DIR, 'sha256:test');

    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'sample-course',
          contentId: 'sample-course',
          title: 'Sample Course',
          level: 'BEGINNER',
          tags: ['testing'],
          outcomes: ['Understand the ingestion pipeline.'],
          requirements: ['None.'],
          assets: {
            create: [
              expect.objectContaining({ objectKey: 'cover.png', type: 'image', altText: 'Cover image' }),
            ],
          },
          versions: {
            create: expect.objectContaining({
              version: 1,
              imageDigest: 'sha256:test',
              sourceMarkdown: expect.stringContaining('Section one body.'),
              modules: {
                create: [
                  expect.objectContaining({
                    position: 1,
                    title: 'Module One',
                    lessons: {
                      create: [
                        expect.objectContaining({ position: 1, title: 'Lesson One', assessmentIds: ['check-lesson-1'] }),
                        expect.objectContaining({ position: 2, title: 'Lesson Two', assessmentIds: ['check-lesson-2'] }),
                      ],
                    },
                  }),
                ],
              },
            }),
          },
        }),
      }),
    );
  });

  it('course.json 不存在时抛出可读的错误', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.ingestFromDirectory('/tmp/does-not-exist')).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- course-ingestion.service`
Expected: FAIL — `Cannot find module './course-ingestion.service'`.

- [ ] **Step 7: Implement `course-ingestion.service.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Course, CourseVersion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseContentSchema, mapCourseLevel } from './course-content.schemas';

@Injectable()
export class CourseIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestFromDirectory(
    contentDir: string,
    imageDigest?: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    const courseJsonRaw = await readFile(resolve(contentDir, 'course.json'), 'utf-8');
    const content = CourseContentSchema.parse(JSON.parse(courseJsonRaw));

    const sourceMarkdown = await readFile(
      resolve(contentDir, content.source.path),
      content.source.encoding as BufferEncoding,
    );

    return this.prisma.course.create({
      data: {
        slug: content.slug,
        contentId: content.id,
        title: content.metadata.title,
        shortTitle: content.metadata.shortTitle ?? null,
        category: content.metadata.category,
        description: content.metadata.description,
        level: mapCourseLevel(content.metadata.level),
        language: content.metadata.language,
        durationMinutes: content.metadata.durationMinutes,
        lessonCount: content.metadata.lessonCount,
        tags: content.metadata.tags,
        outcomes: content.outcomes,
        requirements: content.requirements,
        assets: {
          create: content.assets.map((asset) => ({
            objectKey: asset.path,
            type: asset.type,
            altText: asset.alt,
          })),
        },
        versions: {
          create: {
            version: content.version,
            imageDigest: imageDigest ?? null,
            sourceFormat: content.source.format,
            sourcePath: content.source.path,
            sourceEncoding: content.source.encoding,
            sourceMarkdown,
            introSourceRange: content.introduction.sourceRange,
            introFeaturedAssetIds: content.introduction.featuredAssetIds,
            modules: {
              create: content.modules.map((courseModule) => ({
                position: courseModule.position,
                title: courseModule.title,
                description: courseModule.description,
                estimatedMinutes: courseModule.estimatedMinutes,
                lessons: {
                  create: courseModule.lessons.map((lesson) => ({
                    position: lesson.position,
                    title: lesson.title,
                    estimatedMinutes: lesson.estimatedMinutes,
                    objectives: lesson.objectives,
                    sourceRange: lesson.sourceRange,
                    activityType: lesson.activity.type,
                    activityPrompt: lesson.activity.prompt,
                    activityCompletionType: lesson.activity.completionType,
                    assessmentIds: lesson.assessmentIds,
                  })),
                },
              })),
            },
          },
        },
      },
      include: { versions: true },
    });
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- course-ingestion.service`
Expected: PASS (2 tests).

- [ ] **Step 9: Create `courses.module.ts` (empty controller for now, populated in Task 3)**

```typescript
import { Module } from '@nestjs/common';
import { CourseIngestionService } from './course-ingestion.service';

@Module({
  providers: [CourseIngestionService],
  exports: [CourseIngestionService],
})
export class CoursesModule {}
```

- [ ] **Step 10: Wire `CoursesModule` into `AdminModule` and rewrite `AdminService.createCourse`/`publishCourse`**

Modify `src/admin/admin.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InviteCommand } from './commands/invite.command';
import {
  CourseCreateCommand,
  CoursePublishCommand,
} from './commands/course.command';
import { EnrollCommand } from './commands/enroll.command';
import { QuotaGrantCommand } from './commands/quota.command';
import { CoursesModule } from '../courses/courses.module';

@Module({
  imports: [CoursesModule],
  providers: [
    AdminService,
    InviteCommand,
    CourseCreateCommand,
    CoursePublishCommand,
    EnrollCommand,
    QuotaGrantCommand,
  ],
  exports: [AdminService],
})
export class AdminModule {}
```

Modify `src/admin/admin.service.ts` — replace the `createCourse` method and inject `CourseIngestionService`, and fix `publishCourse` to also flip `Course.published`:

```typescript
// add to imports at top of file:
import { CourseIngestionService } from '../courses/course-ingestion.service';

// change constructor to:
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly courseIngestion: CourseIngestionService,
  ) {}

// replace createCourse with:
  async createCourse(
    contentDir: string,
    operator: string,
    reason: string,
    imageDigest?: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    const course = await this.courseIngestion.ingestFromDirectory(
      contentDir,
      imageDigest,
    );

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.createCourse',
      success: true,
      targetType: 'Course',
      targetId: course.id,
      reason,
    });

    return course;
  }

// replace publishCourse's body (keep the signature) with:
  async publishCourse(
    slug: string,
    operator: string,
    reason: string,
  ): Promise<CourseVersion> {
    const course = await this.requireCourse(slug);
    const latest = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id },
      orderBy: { version: 'desc' },
    });
    if (!latest) {
      throw new NotFoundException(`课程 ${slug} 还没有任何版本`);
    }

    const published = latest.publishedAt
      ? latest
      : await this.prisma.courseVersion.update({
          where: { id: latest.id },
          data: { publishedAt: new Date() },
        });

    if (!course.published) {
      await this.prisma.course.update({
        where: { id: course.id },
        data: { published: true },
      });
    }

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.publishCourse',
      success: true,
      targetType: 'CourseVersion',
      targetId: published.id,
      reason,
    });

    return published;
  }
```

- [ ] **Step 11: Update `admin.service.spec.ts` for the new `createCourse` signature and the `publishCourse` fix**

In `src/admin/admin.service.spec.ts`, update `buildPrisma()` to add a `course.update` mock and a `CourseIngestionService` stub, and rewrite the `createCourse`/`publishCourse` describe blocks:

```typescript
// add to buildPrisma()'s returned object:
  course: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },

// add near buildService():
const buildCourseIngestion = () => ({
  ingestFromDirectory: jest.fn(),
});

// change buildService's providers array to also include:
      { provide: CourseIngestionService, useValue: courseIngestion },
// (buildService must now accept and thread through a `courseIngestion` param — update its signature to
// `buildService(prisma, audit = {record: jest.fn()}, courseIngestion = buildCourseIngestion())`)

describe('AdminService.createCourse', () => {
  it('调用摄取服务，并记审计', async () => {
    const prisma = buildPrisma();
    const courseIngestion = buildCourseIngestion();
    courseIngestion.ingestFromDirectory.mockResolvedValue({
      id: 'course_1',
      slug: 'n8n',
      title: 'n8n 自动化工作流',
      versions: [{ version: 1 }],
    });
    const { service, audit } = await buildService(prisma, undefined, courseIngestion);

    const course = await service.createCourse('/content/n8n', OPERATOR, REASON, 'sha256:abc');

    expect(courseIngestion.ingestFromDirectory).toHaveBeenCalledWith('/content/n8n', 'sha256:abc');
    expect(course.slug).toBe('n8n');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.createCourse', targetId: 'course_1' }),
    );
  });
});

describe('AdminService.publishCourse', () => {
  it('发布未发布过的版本时，同时把 Course.published 置为 true', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n', published: false });
    prisma.courseVersion.findFirst.mockResolvedValue({ id: 'version_1', version: 1, publishedAt: null });
    prisma.courseVersion.update.mockResolvedValue({ id: 'version_1', version: 1, publishedAt: new Date() });
    const { service } = await buildService(prisma);

    await service.publishCourse('n8n', OPERATOR, REASON);

    expect(prisma.course.update).toHaveBeenCalledWith({
      where: { id: 'course_1' },
      data: { published: true },
    });
  });

  it('课程已经 published 时不重复调用 course.update', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n', published: true });
    prisma.courseVersion.findFirst.mockResolvedValue({ id: 'version_1', version: 1, publishedAt: new Date() });
    const { service } = await buildService(prisma);

    await service.publishCourse('n8n', OPERATOR, REASON);

    expect(prisma.course.update).not.toHaveBeenCalled();
  });
});
```

Also add `import { CourseIngestionService } from '../courses/course-ingestion.service';` to the spec file's imports, and delete the old `createCourse`/`publishCourse` tests that assumed the old `(slug, title, ...)` signature.

- [ ] **Step 12: Update the CLI command for the new `course:create` interface**

Replace `CourseCreateCommand` in `src/admin/commands/course.command.ts`:

```typescript
interface CourseCreateOptions {
  operator: string;
  reason: string;
  execute?: boolean;
  imageDigest?: string;
}

@Command({
  name: 'course:create',
  arguments: '<contentDir>',
  description: '从课程内容目录（含 course.json）摄取新建课程',
})
export class CourseCreateCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: CourseCreateOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [contentDir] = inputs;

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'course:create',
          dryRun: true,
          operator,
          reason,
          contentDir,
          imageDigest: options.imageDigest ?? null,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const course = await this.admin.createCourse(
      contentDir,
      operator,
      reason,
      options.imageDigest,
    );

    console.log(
      JSON.stringify({
        command: 'course:create',
        dryRun: false,
        operator,
        reason,
        slug: course.slug,
        title: course.title,
        version: course.versions[0]?.version,
      }),
    );
  }

  @Option({
    flags: '-o, --operator <operator>',
    description: '执行本次操作的人（邮箱）',
    required: true,
  })
  parseOperator(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --reason <reason>',
    description: '本次操作的原因',
    required: true,
  })
  parseReason(val: string): string {
    return val;
  }

  @Option({
    flags: '-e, --execute',
    description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）',
  })
  parseExecute(): boolean {
    return true;
  }

  @Option({
    flags: '-i, --image-digest <imageDigest>',
    description: 'VM 镜像摘要，Labs 集成前可以不填',
  })
  parseImageDigest(val: string): string {
    return val;
  }
}
```

(`CoursePublishCommand` below it in the same file is unchanged.)

- [ ] **Step 13: Update `course.command.spec.ts`'s `CourseCreateCommand` tests**

Replace the `describe('CourseCreateCommand', ...)` block in `src/admin/commands/course.command.spec.ts`:

```typescript
describe('CourseCreateCommand', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dry-run 不调用 AdminService', async () => {
    const createCourse = jest.fn();
    const command = await buildCommand(CourseCreateCommand, { createCourse });

    await command.run(['/content/n8n'], {
      operator: OPERATOR,
      reason: REASON,
    });

    expect(createCourse).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:create',
        dryRun: true,
        operator: OPERATOR,
        reason: REASON,
        contentDir: '/content/n8n',
        imageDigest: null,
        note: '加 --execute 才会真正写库',
      }),
    );
  });

  it('--execute 会调用 AdminService 并透传 imageDigest', async () => {
    const createCourse = jest.fn().mockResolvedValue({
      slug: 'n8n',
      title: 'n8n 自动化工作流',
      versions: [{ version: 1 }],
    });
    const command = await buildCommand(CourseCreateCommand, { createCourse });

    await command.run(['/content/n8n'], {
      operator: OPERATOR,
      reason: REASON,
      execute: true,
      imageDigest: 'sha256:abc',
    });

    expect(createCourse).toHaveBeenCalledWith(
      '/content/n8n',
      OPERATOR,
      REASON,
      'sha256:abc',
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        command: 'course:create',
        dryRun: false,
        operator: OPERATOR,
        reason: REASON,
        slug: 'n8n',
        title: 'n8n 自动化工作流',
        version: 1,
      }),
    );
  });

  it('reason 为空时拒绝，不调用 AdminService', async () => {
    const createCourse = jest.fn();
    const command = await buildCommand(CourseCreateCommand, { createCourse });

    await expect(
      command.run(['/content/n8n'], {
        operator: OPERATOR,
        reason: '',
      }),
    ).rejects.toThrow('reason 不能为空');
    expect(createCourse).not.toHaveBeenCalled();
  });
});
```

(`CoursePublishCommand`'s describe block below is unchanged.)

- [ ] **Step 14: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites green (this touches `admin.service.spec.ts`, `course.command.spec.ts`, plus the two new spec files from this task).

- [ ] **Step 15: Commit**

```bash
git add src/courses src/admin
git commit -m "feat(courses): ingest course.json into the DB at course:create

course:create now takes a content directory instead of slug/title —
it reads course.json, validates it against the real Labs shape, and
writes Course/CourseVersion/CourseAsset/CourseModule/CourseLesson in
one nested Prisma create. Also fixes publishCourse, which previously
never flipped Course.published to true despite the schema comment
saying it would."
```

---

### Task 3: Courses read API — list, detail, welcome

**Files:**
- Create: `src/courses/courses.service.ts`
- Create: `src/courses/courses.service.spec.ts`
- Create: `src/courses/courses.controller.ts`
- Create: `src/courses/courses.controller.spec.ts`
- Modify: `src/courses/courses.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `JwtAuthGuard`/`AuthenticatedRequest` (from `src/auth/jwt-auth.guard.ts`).
- Produces: `CoursesService.listPublished(): Promise<CourseListItem[]>`, `CoursesService.getDetail(slug: string): Promise<CourseDetailResponse>` (throws `NotFoundException` if missing/unpublished), `CoursesService.getWelcome(slug: string): Promise<CourseWelcomeResponse>` (throws `NotFoundException`). These three exact method names/signatures are relied on by Task 4 and Task 5's `EnrollmentsService`, which also needs `CoursesService`'s course-lookup-by-slug helper — export a fourth method: `CoursesService.requirePublishedCourseWithLatestVersion(slug: string)` returning the raw Prisma row (course + latest version), used internally and by Task 5.

- [ ] **Step 1: Write the service test (failing)**

Create `src/courses/courses.service.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CoursesService } from './courses.service';

const buildPrisma = () => ({
  course: { findMany: jest.fn(), findUnique: jest.fn() },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [CoursesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(CoursesService);
};

describe('CoursesService.listPublished', () => {
  it('只列已发布课程，id 字段用 slug 而不是内部 cuid', async () => {
    const prisma = buildPrisma();
    prisma.course.findMany.mockResolvedValue([
      {
        id: 'course_cuid_1',
        slug: 'ai-daily-briefing',
        title: 'Build an AI Daily Briefing',
        category: 'AI Automation',
        description: 'desc',
        level: 'INTERMEDIATE',
        durationMinutes: 480,
        lessonCount: 11,
        published: true,
        coverAssetId: null,
      },
    ]);
    const service = await buildService(prisma);

    const result = await service.listPublished();

    expect(prisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'ai-daily-briefing',
        level: 'Intermediate',
      }),
    ]);
  });
});

describe('CoursesService.getDetail', () => {
  it('课程不存在时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.getDetail('missing')).rejects.toThrow(NotFoundException);
  });

  it('返回完整 detail，modules/lessons 按 position 排序拼好', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'ai-daily-briefing',
      contentId: 'n8n-agent-builder',
      title: 'Build an AI Daily Briefing',
      shortTitle: 'AI Daily Briefing',
      category: 'AI Automation',
      description: 'desc',
      level: 'INTERMEDIATE',
      language: 'en',
      durationMinutes: 480,
      lessonCount: 11,
      tags: ['n8n'],
      outcomes: ['outcome 1'],
      requirements: ['req 1'],
      published: true,
      coverAssetId: null,
      versions: [
        {
          id: 'version_1',
          version: 1,
          modules: [
            {
              id: 'module_1',
              position: 1,
              title: 'Module One',
              description: 'desc',
              estimatedMinutes: 150,
              lessons: [
                {
                  id: 'lesson_1',
                  position: 1,
                  title: 'Lesson One',
                  estimatedMinutes: 25,
                  objectives: ['obj'],
                  activityType: 'guided-lab',
                  activityPrompt: 'prompt',
                  activityCompletionType: 'learner-confirmation',
                },
              ],
            },
          ],
        },
      ],
    });
    const service = await buildService(prisma);

    const detail = await service.getDetail('ai-daily-briefing');

    expect(detail.id).toBe('ai-daily-briefing');
    expect(detail.version).toBe(1);
    expect(detail.modules[0].lessons[0]).toEqual(
      expect.objectContaining({
        id: 'lesson_1',
        activity: { type: 'guided-lab', prompt: 'prompt', completionType: 'learner-confirmation' },
      }),
    );
  });
});

describe('CoursesService.getWelcome', () => {
  it('welcome.json 还没摄取时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'ai-daily-briefing',
      versions: [{ id: 'version_1', welcome: null }],
    });
    const service = await buildService(prisma);

    await expect(service.getWelcome('ai-daily-briefing')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- courses.service`
Expected: FAIL — `Cannot find module './courses.service'`.

- [ ] **Step 3: Implement `courses.service.ts`**

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const LEVEL_TO_CLIENT: Record<string, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
};

export type CourseListItem = {
  id: string;
  title: string;
  category: string;
  description: string;
  level: string;
  durationMinutes: number;
  lessonCount: number;
  published: boolean;
  coverAssetId: string | null;
};

export type CourseDetailResponse = CourseListItem & {
  slug: string;
  version: number;
  shortTitle: string | null;
  language: string;
  tags: string[];
  outcomes: string[];
  requirements: string[];
  modules: Array<{
    id: string;
    position: number;
    title: string;
    description: string;
    estimatedMinutes: number;
    lessons: Array<{
      id: string;
      position: number;
      title: string;
      estimatedMinutes: number;
      objectives: string[];
      activity: { type: string; prompt: string; completionType: string };
    }>;
  }>;
};

export type CourseWelcomeResponse = {
  overviewAssetId: string | null;
  overviewHeading: string | null;
  overviewParagraphs: string[];
  howItWorksSteps: unknown;
  finalOutcome: string | null;
};

const COURSE_WITH_LATEST_VERSION_INCLUDE = {
  versions: {
    orderBy: { version: 'desc' as const },
    take: 1,
    include: {
      modules: {
        orderBy: { position: 'asc' as const },
        include: { lessons: { orderBy: { position: 'asc' as const } } },
      },
      welcome: true,
    },
  },
};

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async listPublished(): Promise<CourseListItem[]> {
    const courses = await this.prisma.course.findMany({
      where: { published: true },
      orderBy: { createdAt: 'asc' },
    });
    return courses.map((course) => this.toListItem(course));
  }

  async getDetail(slug: string): Promise<CourseDetailResponse> {
    const course = await this.requirePublishedCourseWithLatestVersion(slug);
    const version = course.versions[0];

    return {
      ...this.toListItem(course),
      slug: course.slug,
      version: version.version,
      shortTitle: course.shortTitle,
      language: course.language,
      tags: course.tags,
      outcomes: course.outcomes,
      requirements: course.requirements,
      modules: version.modules.map((courseModule) => ({
        id: courseModule.id,
        position: courseModule.position,
        title: courseModule.title,
        description: courseModule.description,
        estimatedMinutes: courseModule.estimatedMinutes,
        lessons: courseModule.lessons.map((lesson) => ({
          id: lesson.id,
          position: lesson.position,
          title: lesson.title,
          estimatedMinutes: lesson.estimatedMinutes,
          objectives: lesson.objectives,
          activity: {
            type: lesson.activityType,
            prompt: lesson.activityPrompt,
            completionType: lesson.activityCompletionType,
          },
        })),
      })),
    };
  }

  async getWelcome(slug: string): Promise<CourseWelcomeResponse> {
    const course = await this.requirePublishedCourseWithLatestVersion(slug);
    const welcome = course.versions[0].welcome;
    if (!welcome) {
      throw new NotFoundException(`课程 ${slug} 还没有欢迎页内容`);
    }
    return {
      overviewAssetId: welcome.overviewAssetId,
      overviewHeading: welcome.overviewHeading,
      overviewParagraphs: welcome.overviewParagraphs,
      howItWorksSteps: welcome.howItWorksSteps,
      finalOutcome: welcome.finalOutcome,
    };
  }

  async requirePublishedCourseWithLatestVersion(slug: string) {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      include: COURSE_WITH_LATEST_VERSION_INCLUDE,
    });
    if (!course || !course.published || course.versions.length === 0) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }
    return course;
  }

  private toListItem(course: {
    slug: string;
    title: string;
    category: string;
    description: string;
    level: string;
    durationMinutes: number;
    lessonCount: number;
    published: boolean;
    coverAssetId: string | null;
  }): CourseListItem {
    return {
      id: course.slug,
      title: course.title,
      category: course.category,
      description: course.description,
      level: LEVEL_TO_CLIENT[course.level] ?? course.level,
      durationMinutes: course.durationMinutes,
      lessonCount: course.lessonCount,
      published: course.published,
      coverAssetId: course.coverAssetId,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- courses.service`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the controller test (failing)**

Create `src/courses/courses.controller.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';

describe('CoursesController', () => {
  it('GET /courses 委托给 service.listPublished', async () => {
    const service = { listPublished: jest.fn().mockResolvedValue([{ id: 'sample' }]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.list()).resolves.toEqual([{ id: 'sample' }]);
    expect(service.listPublished).toHaveBeenCalled();
  });

  it('GET /courses/:slug 委托给 service.getDetail', async () => {
    const service = { getDetail: jest.fn().mockResolvedValue({ id: 'sample' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.detail('sample')).resolves.toEqual({ id: 'sample' });
    expect(service.getDetail).toHaveBeenCalledWith('sample');
  });

  it('GET /courses/:slug/welcome 委托给 service.getWelcome', async () => {
    const service = { getWelcome: jest.fn().mockResolvedValue({ overviewHeading: 'hi' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.welcome('sample')).resolves.toEqual({ overviewHeading: 'hi' });
    expect(service.getWelcome).toHaveBeenCalledWith('sample');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- courses.controller`
Expected: FAIL — `Cannot find module './courses.controller'`.

- [ ] **Step 7: Implement `courses.controller.ts`**

```typescript
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CoursesService,
  type CourseDetailResponse,
  type CourseListItem,
  type CourseWelcomeResponse,
} from './courses.service';

@ApiTags('Courses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  list(): Promise<CourseListItem[]> {
    return this.coursesService.listPublished();
  }

  @Get(':slug')
  detail(@Param('slug') slug: string): Promise<CourseDetailResponse> {
    return this.coursesService.getDetail(slug);
  }

  @Get(':slug/welcome')
  welcome(@Param('slug') slug: string): Promise<CourseWelcomeResponse> {
    return this.coursesService.getWelcome(slug);
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- courses.controller`
Expected: PASS (3 tests).

- [ ] **Step 9: Wire `CoursesService`/`CoursesController` into `courses.module.ts`, and the module into `AppModule`**

Update `src/courses/courses.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { CourseIngestionService } from './course-ingestion.service';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [CoursesController],
  providers: [CourseIngestionService, CoursesService],
  exports: [CourseIngestionService, CoursesService],
})
export class CoursesModule {}
```

Update `src/app.module.ts` — add the import and list entry:

```typescript
import { CoursesModule } from './courses/courses.module';
// ...
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminModule,
    HealthModule,
    CoursesModule,
  ],
```

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 11: Commit**

```bash
git add src/courses src/app.module.ts
git commit -m "feat(courses): add GET /courses, /courses/:slug, /courses/:slug/welcome

Course-facing id fields are the slug, never the internal cuid — the
client round-trips whatever GET /courses returns as the id straight
into the next request's URL."
```

---

### Task 4: Lesson detail — markdown slice + navigation

**Files:**
- Modify: `src/courses/courses.service.ts` (add `getLesson`)
- Modify: `src/courses/courses.service.spec.ts`
- Modify: `src/courses/courses.controller.ts` (add route)
- Modify: `src/courses/courses.controller.spec.ts`

**Interfaces:**
- Consumes: `CoursesService.requirePublishedCourseWithLatestVersion` (from Task 3).
- Produces: `CoursesService.getLesson(slug: string, lessonId: string): Promise<LessonResponse>`.

- [ ] **Step 1: Add the failing test**

Add to `src/courses/courses.service.spec.ts`:

```typescript
describe('CoursesService.getLesson', () => {
  const versionWithTwoLessons = {
    id: 'version_1',
    version: 1,
    sourceMarkdown: 'line1\nline2\nline3\nline4\nline5\nline6\n',
    modules: [
      {
        id: 'module_1',
        position: 1,
        title: 'Module One',
        lessons: [
          {
            id: 'lesson_1',
            position: 1,
            title: 'Lesson One',
            estimatedMinutes: 15,
            objectives: ['a'],
            sourceRange: { startLine: 1, endLine: 2 },
            activityType: 'guided-lab',
            activityPrompt: 'p',
            activityCompletionType: 'learner-confirmation',
          },
          {
            id: 'lesson_2',
            position: 2,
            title: 'Lesson Two',
            estimatedMinutes: 15,
            objectives: ['b'],
            sourceRange: { startLine: 3, endLine: 4 },
            activityType: 'guided-lab',
            activityPrompt: 'p',
            activityCompletionType: 'learner-confirmation',
          },
        ],
      },
    ],
  };

  it('按 sourceRange 从 sourceMarkdown 里切出正文，算出 navigation', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    const lesson = await service.getLesson('sample', 'lesson_1');

    expect(lesson.markdown).toBe('line1\nline2');
    expect(lesson.module).toEqual({ id: 'module_1', title: 'Module One', position: 1 });
    expect(lesson.navigation).toEqual({
      previousLessonId: null,
      nextLessonId: 'lesson_2',
      index: 0,
      total: 2,
    });
    expect(lesson.assessment).toBeNull();
  });

  it('第二课的 navigation 指回第一课，且没有 next', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    const lesson = await service.getLesson('sample', 'lesson_2');

    expect(lesson.markdown).toBe('line3\nline4');
    expect(lesson.navigation).toEqual({
      previousLessonId: 'lesson_1',
      nextLessonId: null,
      index: 1,
      total: 2,
    });
  });

  it('lessonId 不属于该课程时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_cuid_1',
      slug: 'sample',
      versions: [versionWithTwoLessons],
    });
    const service = await buildService(prisma);

    await expect(service.getLesson('sample', 'nope')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- courses.service`
Expected: FAIL — `service.getLesson is not a function`.

- [ ] **Step 3: Implement `getLesson` in `courses.service.ts`**

Add to the exported types section:

```typescript
export type LessonResponse = {
  courseId: string;
  module: { id: string; title: string; position: number };
  lesson: {
    id: string;
    position: number;
    title: string;
    estimatedMinutes: number;
    objectives: string[];
    activity: { type: string; prompt: string; completionType: string };
  };
  markdown: string;
  assessment: null;
  navigation: {
    previousLessonId: string | null;
    nextLessonId: string | null;
    index: number;
    total: number;
  };
};
```

Add the method to `CoursesService`:

```typescript
  async getLesson(slug: string, lessonId: string): Promise<LessonResponse> {
    const course = await this.requirePublishedCourseWithLatestVersion(slug);
    const version = course.versions[0];
    const sourceLines = version.sourceMarkdown?.split('\n') ?? [];

    const flattened = version.modules.flatMap((courseModule) =>
      courseModule.lessons.map((lesson) => ({ courseModule, lesson })),
    );
    const index = flattened.findIndex((entry) => entry.lesson.id === lessonId);
    if (index === -1) {
      throw new NotFoundException(`课程 ${slug} 里找不到课时：${lessonId}`);
    }

    const { courseModule, lesson } = flattened[index];
    const range = lesson.sourceRange as { startLine: number; endLine: number };
    const markdown = sourceLines.slice(range.startLine - 1, range.endLine).join('\n');

    return {
      courseId: course.slug,
      module: { id: courseModule.id, title: courseModule.title, position: courseModule.position },
      lesson: {
        id: lesson.id,
        position: lesson.position,
        title: lesson.title,
        estimatedMinutes: lesson.estimatedMinutes,
        objectives: lesson.objectives,
        activity: {
          type: lesson.activityType,
          prompt: lesson.activityPrompt,
          completionType: lesson.activityCompletionType,
        },
      },
      markdown,
      // LessonAssessment 行要等 assessments.json 落地才会存在，这轮之前先固定返回 null。
      assessment: null,
      navigation: {
        previousLessonId: flattened[index - 1]?.lesson.id ?? null,
        nextLessonId: flattened[index + 1]?.lesson.id ?? null,
        index,
        total: flattened.length,
      },
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- courses.service`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Add the controller route + test**

Add to `src/courses/courses.controller.spec.ts`:

```typescript
  it('GET /courses/:slug/lessons/:lessonId 委托给 service.getLesson', async () => {
    const service = { getLesson: jest.fn().mockResolvedValue({ markdown: 'body' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.lesson('sample', 'lesson_1')).resolves.toEqual({ markdown: 'body' });
    expect(service.getLesson).toHaveBeenCalledWith('sample', 'lesson_1');
  });
```

Add to `courses.controller.ts`:

```typescript
  @Get(':slug/lessons/:lessonId')
  lesson(
    @Param('slug') slug: string,
    @Param('lessonId') lessonId: string,
  ): Promise<LessonResponse> {
    return this.coursesService.getLesson(slug, lessonId);
  }
```

(add `type LessonResponse` to the existing `courses.service` import at the top of the file)

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/courses
git commit -m "feat(courses): add GET /courses/:slug/lessons/:lessonId

Slices the lesson's markdown out of CourseVersion.sourceMarkdown using
its sourceRange, and computes prev/next navigation by flattening all
modules' lessons in position order. assessment is hardcoded null until
assessments.json exists and LessonAssessment rows are real."
```

---

### Task 5: Enrollments — enroll, restart, list, complete lesson

**Files:**
- Create: `src/enrollments/enrollments.service.ts`
- Create: `src/enrollments/enrollments.service.spec.ts`
- Create: `src/enrollments/enrollments.controller.ts`
- Create: `src/enrollments/enrollments.controller.spec.ts`
- Create: `src/enrollments/enrollments.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AuditService`, `JwtAuthGuard`/`AuthenticatedRequest`, `CoursesService.requirePublishedCourseWithLatestVersion` (Task 3).
- Produces: `EnrollmentsService.enroll(userId, slug): Promise<EnrollmentResponse>`, `EnrollmentsService.restart(userId, slug): Promise<EnrollmentResponse>`, `EnrollmentsService.listForUser(userId): Promise<EnrollmentResponse[]>`, `EnrollmentsService.completeLesson(userId, lessonId): Promise<void>`.

- [ ] **Step 1: Write the service test (failing)**

Create `src/enrollments/enrollments.service.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EnrollmentsService } from './enrollments.service';

const buildPrisma = () => ({
  course: { findUnique: jest.fn() },
  enrollment: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  progress: { upsert: jest.fn() },
  courseLesson: { findUnique: jest.fn() },
  activity: { create: jest.fn() },
  $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback({})),
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  audit = { record: jest.fn() },
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EnrollmentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(EnrollmentsService), audit };
};

const USER_ID = 'user_1';

describe('EnrollmentsService.enroll', () => {
  it('课程不存在或未发布时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(service.enroll(USER_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('先把其他课程的 enrollment 设成 active=false，再 upsert 这门课为 active=true，并记审计', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({
      id: 'course_1',
      slug: 'sample',
      title: 'Sample',
      category: 'cat',
      description: 'desc',
      level: 'BEGINNER',
      durationMinutes: 30,
      lessonCount: 2,
      published: true,
      coverAssetId: null,
    });
    prisma.enrollment.upsert.mockResolvedValue({
      id: 'enrollment_1',
      userId: USER_ID,
      courseId: 'course_1',
      active: true,
      currentModule: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    const { service, audit } = await buildService(prisma);

    const result = await service.enroll(USER_ID, 'sample');

    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, active: true },
      data: { active: false },
    });
    expect(prisma.enrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_courseId: { userId: USER_ID, courseId: 'course_1' } },
        update: { active: true },
        create: expect.objectContaining({ userId: USER_ID, courseId: 'course_1', active: true }),
      }),
    );
    expect(result.courseId).toBe('sample');
    expect(result.progressPercent).toBe(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.USER, id: USER_ID },
        action: 'enrollment.enroll',
      }),
    );
  });
});

describe('EnrollmentsService.completeLesson', () => {
  it('课时不存在时抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.courseLesson.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(service.completeLesson(USER_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('写一行 Activity，并把 Progress 推进到下一课', async () => {
    const prisma = buildPrisma();
    prisma.courseLesson.findUnique.mockResolvedValue({
      id: 'lesson_1',
      title: 'Lesson One',
      module: {
        id: 'module_1',
        courseVersion: {
          courseId: 'course_1',
          modules: [
            {
              lessons: [{ id: 'lesson_1' }, { id: 'lesson_2' }],
            },
          ],
        },
      },
    });
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'enrollment_1' });
    const { service } = await buildService(prisma);

    await service.completeLesson(USER_ID, 'lesson_1');

    expect(prisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER_ID, enrollmentId: 'enrollment_1', kind: 'LESSON' }),
      }),
    );
    expect(prisma.progress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollmentId: 'enrollment_1' },
        update: { currentLessonId: 'lesson_2' },
        create: expect.objectContaining({ enrollmentId: 'enrollment_1', currentLessonId: 'lesson_2' }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- enrollments.service`
Expected: FAIL — `Cannot find module './enrollments.service'`.

- [ ] **Step 3: Implement `enrollments.service.ts`**

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export type EnrollmentResponse = {
  id: string;
  userId: string;
  courseId: string;
  active: boolean;
  progressPercent: number;
  currentModule: string;
  enrolledAt: string;
};

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async enroll(userId: string, slug: string): Promise<EnrollmentResponse> {
    const course = await this.requirePublishedCourse(slug);

    await this.prisma.enrollment.updateMany({
      where: { userId, active: true },
      data: { active: false },
    });

    const enrollment = await this.prisma.enrollment.upsert({
      where: { userId_courseId: { userId, courseId: course.id } },
      update: { active: true },
      create: { userId, courseId: course.id, active: true },
      include: { currentModule: true },
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.enroll',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });

    return this.toResponse(enrollment, course.slug, 0);
  }

  async restart(userId: string, slug: string): Promise<EnrollmentResponse> {
    const course = await this.requirePublishedCourse(slug);

    await this.prisma.enrollment.updateMany({
      where: { userId, active: true },
      data: { active: false },
    });

    const enrollment = await this.prisma.enrollment.upsert({
      where: { userId_courseId: { userId, courseId: course.id } },
      update: { active: true, currentModuleId: null },
      create: { userId, courseId: course.id, active: true },
      include: { currentModule: true },
    });

    await this.prisma.progress.upsert({
      where: { enrollmentId: enrollment.id },
      update: { currentLessonId: null },
      create: { enrollmentId: enrollment.id },
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'enrollment.restart',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
    });

    return this.toResponse(enrollment, course.slug, 0);
  }

  async listForUser(userId: string): Promise<EnrollmentResponse[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId },
      include: { course: true, currentModule: true },
      orderBy: { createdAt: 'asc' },
    });
    return enrollments.map((enrollment) =>
      this.toResponse(enrollment, enrollment.course.slug, 0),
    );
  }

  async completeLesson(userId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.courseLesson.findUnique({
      where: { id: lessonId },
      include: {
        module: {
          include: {
            courseVersion: {
              include: { modules: { include: { lessons: true }, orderBy: { position: 'asc' } } },
            },
          },
        },
      },
    });
    if (!lesson) {
      throw new NotFoundException(`找不到课时：${lessonId}`);
    }

    const courseId = lesson.module.courseVersion.courseId;
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { userId, courseId },
    });
    if (!enrollment) {
      throw new NotFoundException(`用户还没有报名这门课`);
    }

    await this.prisma.activity.create({
      data: {
        userId,
        enrollmentId: enrollment.id,
        kind: 'LESSON',
        title: lesson.title,
        detail: `完成课时：${lesson.title}`,
      },
    });

    const flattened = lesson.module.courseVersion.modules.flatMap(
      (courseModule) => courseModule.lessons,
    );
    const index = flattened.findIndex((entry) => entry.id === lessonId);
    const nextLessonId = flattened[index + 1]?.id ?? null;

    await this.prisma.progress.upsert({
      where: { enrollmentId: enrollment.id },
      update: { currentLessonId: nextLessonId },
      create: { enrollmentId: enrollment.id, currentLessonId: nextLessonId },
    });
  }

  private async requirePublishedCourse(slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course || !course.published) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }
    return course;
  }

  private toResponse(
    enrollment: {
      id: string;
      userId: string;
      courseId: string;
      active: boolean;
      currentModule: { title: string } | null;
      createdAt: Date;
    },
    courseSlug: string,
    progressPercent: number,
  ): EnrollmentResponse {
    return {
      id: enrollment.id,
      userId: enrollment.userId,
      courseId: courseSlug,
      active: enrollment.active,
      progressPercent,
      currentModule: enrollment.currentModule?.title ?? '',
      enrolledAt: enrollment.createdAt.toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- enrollments.service`
Expected: PASS.

> **Note on `progressPercent`:** this task hardcodes it to `0` in `enroll`/`restart` responses (both are the "just started/reset" case, which genuinely is 0%). `listForUser` and the dashboard (Task 6) need the *real* computed percent for an in-progress enrollment — that computation (flatten lessons in order, find `currentLesson`'s index, divide by total) is written once in Task 6's `DashboardService` and reused here via a shared helper in that task's step 3. Do not duplicate the flatten-and-divide logic a third time.

- [ ] **Step 5: Write the controller test (failing)**

Create `src/enrollments/enrollments.controller.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('EnrollmentsController', () => {
  it('POST /courses/:slug/enroll 用认证用户的 userId 调用 service.enroll', async () => {
    const service = { enroll: jest.fn().mockResolvedValue({ id: 'enrollment_1' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await expect(controller.enroll('sample', AUTH_REQUEST as any)).resolves.toEqual({ id: 'enrollment_1' });
    expect(service.enroll).toHaveBeenCalledWith('user_1', 'sample');
  });

  it('POST /courses/:slug/restart 用认证用户的 userId 调用 service.restart', async () => {
    const service = { restart: jest.fn().mockResolvedValue({ id: 'enrollment_1' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await expect(controller.restart('sample', AUTH_REQUEST as any)).resolves.toEqual({ id: 'enrollment_1' });
    expect(service.restart).toHaveBeenCalledWith('user_1', 'sample');
  });

  it('GET /me/enrollments 用认证用户的 userId 调用 service.listForUser', async () => {
    const service = { listForUser: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await expect(controller.myEnrollments(AUTH_REQUEST as any)).resolves.toEqual([]);
    expect(service.listForUser).toHaveBeenCalledWith('user_1');
  });

  it('POST /lessons/:lessonId/complete 用认证用户的 userId 调用 service.completeLesson', async () => {
    const service = { completeLesson: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [EnrollmentsController],
      providers: [{ provide: EnrollmentsService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(EnrollmentsController);

    await controller.completeLesson('lesson_1', AUTH_REQUEST as any);
    expect(service.completeLesson).toHaveBeenCalledWith('user_1', 'lesson_1');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- enrollments.controller`
Expected: FAIL — `Cannot find module './enrollments.controller'`.

- [ ] **Step 7: Implement `enrollments.controller.ts`**

```typescript
import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { EnrollmentsService, type EnrollmentResponse } from './enrollments.service';

@ApiTags('Enrollments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @Post('courses/:slug/enroll')
  enroll(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<EnrollmentResponse> {
    return this.enrollmentsService.enroll(request.auth!.userId, slug);
  }

  @Post('courses/:slug/restart')
  restart(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<EnrollmentResponse> {
    return this.enrollmentsService.restart(request.auth!.userId, slug);
  }

  @Get('me/enrollments')
  myEnrollments(@Req() request: AuthenticatedRequest): Promise<EnrollmentResponse[]> {
    return this.enrollmentsService.listForUser(request.auth!.userId);
  }

  @Post('lessons/:lessonId/complete')
  @HttpCode(204)
  completeLesson(
    @Param('lessonId') lessonId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.enrollmentsService.completeLesson(request.auth!.userId, lessonId);
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- enrollments.controller`
Expected: PASS.

- [ ] **Step 9: Create `enrollments.module.ts` and wire into `AppModule`**

```typescript
import { Module } from '@nestjs/common';
import { EnrollmentsService } from './enrollments.service';
import { EnrollmentsController } from './enrollments.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule {}
```

Update `src/app.module.ts`:

```typescript
import { EnrollmentsModule } from './enrollments/enrollments.module';
// ...
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminModule,
    HealthModule,
    CoursesModule,
    EnrollmentsModule,
  ],
```

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/enrollments src/app.module.ts
git commit -m "feat(enrollments): add enroll/restart/list + lesson completion

Enrolling or restarting deactivates any other active enrollment first
(only one active course at a time, per the existing schema comment).
completeLesson writes an Activity row and advances Progress to the
next lesson in module+lesson position order."
```

---

### Task 6: Dashboard, notifications, practice sessions

**Files:**
- Create: `src/dashboard/dashboard.schemas.ts`
- Create: `src/dashboard/dashboard.service.ts`
- Create: `src/dashboard/dashboard.service.spec.ts`
- Create: `src/dashboard/dashboard.controller.ts`
- Create: `src/dashboard/dashboard.controller.spec.ts`
- Create: `src/dashboard/dashboard.module.ts`
- Modify: `src/enrollments/enrollments.service.ts` (replace the hardcoded `0` progress percent with the shared helper below)
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AuditService`, `JwtAuthGuard`/`AuthenticatedRequest`.
- Produces: exported helper `computeProgressPercent(enrollment): number` and `DashboardService.getDashboard(userId)`, `.listNotifications(userId)`, `.markAllNotificationsRead(userId)`, `.recordPractice(userId, minutes)`.

- [ ] **Step 1: Write the request schema**

Create `src/dashboard/dashboard.schemas.ts`:

```typescript
import { z } from 'zod';

export const RecordPracticeSchema = z.object({
  minutes: z.number().int().positive().max(600),
});

export type RecordPracticeInput = z.infer<typeof RecordPracticeSchema>;
```

- [ ] **Step 2: Write the service test (failing)**

Create `src/dashboard/dashboard.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService, computeProgressPercent } from './dashboard.service';

const buildPrisma = () => ({
  user: { findUniqueOrThrow: jest.fn() },
  enrollment: { findFirst: jest.fn() },
  activity: { findMany: jest.fn().mockResolvedValue([]) },
  attempt: { count: jest.fn().mockResolvedValue(0) },
  practiceSession: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: { minutes: 0 } }), create: jest.fn() },
  notification: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [DashboardService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(DashboardService);
};

describe('computeProgressPercent', () => {
  it('没有 currentLessonId 时是 0', () => {
    expect(
      computeProgressPercent({
        progress: null,
        modules: [{ lessons: [{ id: 'l1' }, { id: 'l2' }] }],
      }),
    ).toBe(0);
  });

  it('走到第二课（共 4 课）算出 50', () => {
    expect(
      computeProgressPercent({
        progress: { currentLessonId: 'l2' },
        modules: [{ lessons: [{ id: 'l1' }, { id: 'l2' }] }, { lessons: [{ id: 'l3' }, { id: 'l4' }] }],
      }),
    ).toBe(50);
  });
});

describe('DashboardService.getDashboard', () => {
  it('没有 active enrollment 时 activeCourse 为 null', async () => {
    const prisma = buildPrisma();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user_1',
      displayName: 'Learner',
      email: 'learner@example.com',
      role: 'Learner',
      plan: 'FREE',
      level: 1,
      timezone: 'Asia/Kuala_Lumpur',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    prisma.enrollment.findFirst.mockResolvedValue(null);
    const service = await buildService(prisma);

    const dashboard = await service.getDashboard('user_1');

    expect(dashboard.activeCourse).toBeNull();
    expect(dashboard.progress.skillsMastered).toBe(0);
    expect(dashboard.progress.weeklyHours).toHaveLength(7);
  });
});

describe('DashboardService.recordPractice', () => {
  it('写一行 PracticeSession', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.recordPractice('user_1', 15);

    expect(prisma.practiceSession.create).toHaveBeenCalledWith({
      data: { userId: 'user_1', minutes: 15 },
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- dashboard.service`
Expected: FAIL — `Cannot find module './dashboard.service'`.

- [ ] **Step 4: Implement `dashboard.service.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

type EnrollmentWithVersion = {
  progress: { currentLessonId: string | null } | null;
  modules: Array<{ lessons: Array<{ id: string }> }>;
};

export function computeProgressPercent(enrollment: EnrollmentWithVersion): number {
  const flattened = enrollment.modules.flatMap((courseModule) => courseModule.lessons);
  if (flattened.length === 0 || !enrollment.progress?.currentLessonId) {
    return 0;
  }
  const index = flattened.findIndex((lesson) => lesson.id === enrollment.progress!.currentLessonId);
  if (index === -1) return 0;
  return Math.round(((index + 1) / flattened.length) * 100);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type DashboardResponse = {
  learner: {
    id: string;
    name: string;
    email: string;
    role: string;
    plan: 'Free' | 'Premium';
    level: number;
    timezone: string;
    joinedAt: string;
    streakDays: number;
    skillsMastered: number;
    tasksCompleted: number;
  };
  activeCourse: null | {
    id: string;
    title: string;
    category: string;
    description: string;
    level: string;
    durationMinutes: number;
    lessonCount: number;
    published: boolean;
    coverAssetId: string | null;
    enrollment: {
      id: string;
      userId: string;
      courseId: string;
      active: boolean;
      progressPercent: number;
      currentModule: string;
      enrolledAt: string;
    };
  };
  progress: {
    userId: string;
    streakDays: number;
    skillsMastered: number;
    tasksCompleted: number;
    totalPracticeMinutes: number;
    weeklyHours: number[];
  };
  unreadNotificationCount: number;
  recentActivity: Array<{ id: string; title: string; detail: string; kind: string; occurredAt: string }>;
};

const LEVEL_TO_CLIENT: Record<string, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
};

const KIND_TO_CLIENT: Record<string, string> = {
  LESSON: 'lesson',
  PRACTICE: 'practice',
  ACHIEVEMENT: 'achievement',
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(userId: string): Promise<DashboardResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const activeEnrollment = await this.prisma.enrollment.findFirst({
      where: { userId, active: true },
      include: {
        course: true,
        progress: true,
        courseVersion: { include: { modules: { include: { lessons: true } } } },
      },
    });

    const [streakDays, tasksCompleted, totalPracticeMinutes, weeklyHours, unreadNotificationCount, recentActivity] =
      await Promise.all([
        this.computeStreakDays(userId),
        this.prisma.attempt.count({ where: { status: 'PASS', enrollment: { userId } } }),
        this.sumPracticeMinutes(userId),
        this.computeWeeklyHours(userId),
        this.prisma.notification.count({ where: { userId, readAt: null } }),
        this.prisma.activity.findMany({
          where: { userId },
          orderBy: { occurredAt: 'desc' },
          take: 10,
        }),
      ]);

    return {
      learner: {
        id: user.id,
        name: user.displayName ?? user.email,
        email: user.email,
        role: user.role,
        plan: user.plan === 'PREMIUM' ? 'Premium' : 'Free',
        level: user.level,
        timezone: user.timezone,
        joinedAt: user.createdAt.toISOString(),
        streakDays,
        skillsMastered: 0,
        tasksCompleted,
      },
      activeCourse: activeEnrollment
        ? {
            id: activeEnrollment.course.slug,
            title: activeEnrollment.course.title,
            category: activeEnrollment.course.category,
            description: activeEnrollment.course.description,
            level: LEVEL_TO_CLIENT[activeEnrollment.course.level] ?? activeEnrollment.course.level,
            durationMinutes: activeEnrollment.course.durationMinutes,
            lessonCount: activeEnrollment.course.lessonCount,
            published: activeEnrollment.course.published,
            coverAssetId: activeEnrollment.course.coverAssetId,
            enrollment: {
              id: activeEnrollment.id,
              userId: activeEnrollment.userId,
              courseId: activeEnrollment.course.slug,
              active: activeEnrollment.active,
              progressPercent: activeEnrollment.courseVersion
                ? computeProgressPercent({
                    progress: activeEnrollment.progress,
                    modules: activeEnrollment.courseVersion.modules,
                  })
                : 0,
              currentModule: '',
              enrolledAt: activeEnrollment.createdAt.toISOString(),
            },
          }
        : null,
      progress: {
        userId,
        streakDays,
        skillsMastered: 0,
        tasksCompleted,
        totalPracticeMinutes,
        weeklyHours,
      },
      unreadNotificationCount,
      recentActivity: recentActivity.map((activity) => ({
        id: activity.id,
        title: activity.title,
        detail: activity.detail,
        kind: KIND_TO_CLIENT[activity.kind] ?? activity.kind.toLowerCase(),
        occurredAt: activity.occurredAt.toISOString(),
      })),
    };
  }

  async listNotifications(userId: string) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return notifications.map((notification) => ({
      id: notification.id,
      message: notification.message,
      createdAt: notification.createdAt.toISOString(),
      readAt: notification.readAt?.toISOString() ?? null,
    }));
  }

  async markAllNotificationsRead(userId: string) {
    const readAt = new Date();
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt },
    });
    return { updated: result.count, readAt: readAt.toISOString() };
  }

  async recordPractice(userId: string, minutes: number): Promise<void> {
    await this.prisma.practiceSession.create({ data: { userId, minutes } });
  }

  private async computeStreakDays(userId: string): Promise<number> {
    const activities = await this.prisma.activity.findMany({
      where: { userId },
      select: { occurredAt: true },
      orderBy: { occurredAt: 'desc' },
    });
    const days = [...new Set(activities.map((activity) => dayKey(activity.occurredAt)))].sort().reverse();
    if (days.length === 0) return 0;

    let streak = 1;
    let cursor = new Date(days[0]);
    for (let i = 1; i < days.length; i++) {
      cursor = new Date(cursor.getTime() - DAY_MS);
      if (dayKey(cursor) !== days[i]) break;
      streak++;
    }
    return streak;
  }

  private async sumPracticeMinutes(userId: string): Promise<number> {
    const result = await this.prisma.practiceSession.aggregate({
      where: { userId },
      _sum: { minutes: true },
    });
    return result._sum.minutes ?? 0;
  }

  private async computeWeeklyHours(userId: string): Promise<number[]> {
    const since = new Date(Date.now() - 6 * DAY_MS);
    since.setUTCHours(0, 0, 0, 0);

    const sessions = await this.prisma.practiceSession.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { minutes: true, createdAt: true },
    });

    const minutesByDay = new Map<string, number>();
    for (const session of sessions) {
      const key = dayKey(session.createdAt);
      minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + session.minutes);
    }

    const hours: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * DAY_MS));
      hours.push(Math.round(((minutesByDay.get(key) ?? 0) / 60) * 100) / 100);
    }
    return hours;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- dashboard.service`
Expected: PASS.

- [ ] **Step 6: Replace the hardcoded `0` in `EnrollmentsService.listForUser` with the real computation**

Modify `src/enrollments/enrollments.service.ts`: import `computeProgressPercent` from `../dashboard/dashboard.service`, change `listForUser` to include `courseVersion: { include: { modules: { include: { lessons: true } } } }` and `progress: true` in its Prisma query, and pass the real computed percent instead of the literal `0`:

```typescript
// add import:
import { computeProgressPercent } from '../dashboard/dashboard.service';

// replace listForUser with:
  async listForUser(userId: string): Promise<EnrollmentResponse[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId },
      include: {
        course: true,
        currentModule: true,
        progress: true,
        courseVersion: { include: { modules: { include: { lessons: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return enrollments.map((enrollment) =>
      this.toResponse(
        enrollment,
        enrollment.course.slug,
        enrollment.courseVersion
          ? computeProgressPercent({ progress: enrollment.progress, modules: enrollment.courseVersion.modules })
          : 0,
      ),
    );
  }
```

Update `src/enrollments/enrollments.service.spec.ts`'s `buildPrisma()` to add `courseVersion` handling isn't needed for the existing tests (they don't call `listForUser`) — no test change required here, but confirm `npm test -- enrollments.service` still passes in the next step.

- [ ] **Step 7: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Write the controller test (failing)**

Create `src/dashboard/dashboard.controller.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('DashboardController', () => {
  it('GET /dashboard 用认证用户的 userId 调用 service.getDashboard', async () => {
    const service = { getDashboard: jest.fn().mockResolvedValue({ learner: {} }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(DashboardController);

    await controller.dashboard(AUTH_REQUEST as any);
    expect(service.getDashboard).toHaveBeenCalledWith('user_1');
  });

  it('POST /practice-sessions 校验 minutes 后调用 service.recordPractice', async () => {
    const service = { recordPractice: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(DashboardController);

    await controller.recordPractice({ minutes: 20 }, AUTH_REQUEST as any);
    expect(service.recordPractice).toHaveBeenCalledWith('user_1', 20);
  });

  it('POST /notifications/read-all 调用 service.markAllNotificationsRead', async () => {
    const service = { markAllNotificationsRead: jest.fn().mockResolvedValue({ updated: 2, readAt: 'now' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(DashboardController);

    await expect(controller.markAllRead(AUTH_REQUEST as any)).resolves.toEqual({ updated: 2, readAt: 'now' });
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npm test -- dashboard.controller`
Expected: FAIL — `Cannot find module './dashboard.controller'`.

- [ ] **Step 10: Implement `dashboard.controller.ts`**

```typescript
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { RecordPracticeSchema, type RecordPracticeInput } from './dashboard.schemas';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('dashboard')
  dashboard(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.getDashboard(request.auth!.userId);
  }

  @Get('notifications')
  notifications(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.listNotifications(request.auth!.userId);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  markAllRead(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.markAllNotificationsRead(request.auth!.userId);
  }

  @Post('practice-sessions')
  @HttpCode(204)
  @UsePipes(new ZodValidationPipe(RecordPracticeSchema))
  recordPractice(
    @Body() body: RecordPracticeInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.dashboardService.recordPractice(request.auth!.userId, body.minutes);
  }
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test -- dashboard.controller`
Expected: PASS.

- [ ] **Step 12: Create `dashboard.module.ts` and wire into `AppModule`**

```typescript
import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
```

Update `src/app.module.ts`:

```typescript
import { DashboardModule } from './dashboard/dashboard.module';
// ...
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminModule,
    HealthModule,
    CoursesModule,
    EnrollmentsModule,
    DashboardModule,
  ],
```

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: PASS, every suite green.

- [ ] **Step 14: Commit**

```bash
git add src/dashboard src/enrollments src/app.module.ts
git commit -m "feat(dashboard): add GET /dashboard, notifications, practice-sessions

streakDays/weeklyHours/tasksCompleted are all computed from Activity/
PracticeSession/Attempt at read time, never stored. skillsMastered is
hardcoded to 0 — there is no skill-tagging logic in closed beta.
computeProgressPercent is shared between the dashboard's activeCourse
and EnrollmentsService.listForUser so the definition only exists once."
```

---

### Task 7: End-to-end smoke check

**Files:**
- None created/modified — this task only runs things.

- [ ] **Step 1: Run the full unit test suite one more time**

Run: `npm test`
Expected: PASS, every suite green, no `.only`/`.skip` left in any spec file (grep to confirm: `grep -rn "\.only(\|\.skip(" src` should print nothing).

- [ ] **Step 2: Ingest the real n8n course from aivirteach-labs and manually verify end to end**

Run:
```bash
npm run db:up
npm run cli -- course:create "/Users/owenlee/Desktop/2025年/项目/aivirteach-labs" -o ops@example.com -r "封测首课摄取" --execute
npm run cli -- course:publish ai-daily-briefing -o ops@example.com -r "封测首课发布" --execute
npm run start:dev
```
In another terminal: `curl http://localhost:4000/api/v1/courses` (after obtaining a bearer token via the auth flow, or by adjusting `CoursesController` temporarily if testing pre-auth is inconvenient — do not leave any temporary auth bypass in the committed code).
Expected: the response includes one course with `id: "ai-daily-briefing"`, `lessonCount: 11`; `GET /courses/ai-daily-briefing` returns 2 modules and all 11 lessons; `GET /courses/ai-daily-briefing/lessons/verify-virtual-machine` returns non-empty `markdown` sliced from the real `.md` file.

- [ ] **Step 3: Commit (only if the smoke check needed a fix; otherwise skip)**

If Step 2 surfaced a bug, fix it, add a regression test in the relevant task's spec file, re-run `npm test`, then:
```bash
git add -A
git commit -m "fix: <describe the smoke-test bug found and fixed>"
```

---

## Part B — Client (aivirteach-client) — **DO NOT START UNTIL PART A IS DEPLOYED**

> **Gate:** Every task below assumes `GET /courses`, `GET /courses/:slug`, `GET /courses/:slug/lessons/:lessonId`, `POST /courses/:slug/enroll`, `GET /me/enrollments`, and `POST /lessons/:lessonId/complete` are live on the environment `aivirteach-client`'s `remote` mode points at (`NEXT_PUBLIC_REMOTE_API_BASE_URL`, currently `https://aivirteach-server.vercel.app/api/v1`). Confirm with `curl` against that exact URL before starting — not just against localhost.
>
> **No action needed for dashboard/notifications:** `app/hooks/useLearnerProfile.ts` already tries the real `/dashboard` + `/notifications` endpoints first and only falls back to `mock-profile.ts` on a 404 (see the code comment on line 83: "The deployed control plane currently exposes auth but not learning-data routes."). Once Part A is deployed, that fallback branch simply stops triggering — no client code change required for the dashboard.

### Task 8: Replace `useMockCourseProgress`/`mock-course.ts` with real API calls

**Files:**
- Modify: `app/hooks/useMockCourseProgress.ts` → rename usage sites to a new `app/hooks/useCourseProgress.ts`
- Modify: `app/courses/page.tsx`
- Modify: `app/courses/python-basics/page.tsx`
- Modify: `app/analysis/v2/page.tsx`
- Delete: `app/lib/mock-course.ts` (only after every import above is gone — `grep -rn "mock-course" app` must return nothing)

**Interfaces:**
- Consumes: `api.courses()`, `api.course(slug)`, `api.lesson(slug, lessonId)`, `api.enrollments()`, `api.enroll(slug)`, `api.completeLesson(lessonId)` — all already defined in `app/lib/api.ts` (this plan's Task 1–6 is what makes them return real data instead of 404).

- [ ] **Step 1: Re-read the current three consumers to enumerate exactly what `mock-course.ts` state each one reads**

Before writing any code, run `grep -n "readMockCourseProgress\|startMockCourse\|recordMockCourseAnswer\|resetMockCourseProgress\|addMockCourseTime" app/courses/page.tsx app/courses/python-basics/page.tsx app/analysis/v2/page.tsx` and note every call site — this plan cannot enumerate them from the server-repo side; the engineer executing this task must read the actual current file contents at the time this task runs, since `aivirteach-client` may have changed since this plan was written.

- [ ] **Step 2: Write a new `useCourseProgress` hook backed by real API calls**

Create `app/hooks/useCourseProgress.ts` following the exact structure of `useLearnerProfile.ts` (same file — read it again before writing this, it's the reference pattern: `useState` + `useCallback` refresh + a published/cached module-level variable + a `CustomEvent` for cross-component sync). Replace every `mock-course` function call with the matching real one:
  - `startMockCourse()` / `readMockCourseProgress()` → `api.enrollments()` (find the entry matching the current course slug) + `api.course(slug)` for the module/lesson list.
  - `recordMockCourseAnswer(lessonId, correct)` → do **not** call `api.submitAssessment` (server does not implement it yet, per this plan's Global Constraints) — instead call `api.completeLesson(lessonId)` directly when the learner marks a lesson done, and drop the "answer correctness" concept from this hook entirely until assessment grading exists server-side.
  - `resetMockCourseProgress()` → `api.restartCourse(slug)`.
  - `addMockCourseTime(seconds)` → accumulate locally in the hook's own state and flush via `api.recordPractice(minutes)` on an interval or on unmount, same 5-second cadence the old hook used.

- [ ] **Step 3: Update the three page components to import `useCourseProgress` instead of `useMockCourseProgress`**

For each of `app/courses/page.tsx`, `app/courses/python-basics/page.tsx`, `app/analysis/v2/page.tsx`: replace the import and adjust call sites per the mapping in Step 2. Keep this a mechanical, one-file-at-a-time change — do not restructure the pages beyond swapping the data source.

- [ ] **Step 4: Delete `app/lib/mock-course.ts` and `app/hooks/useMockCourseProgress.ts`**

Run: `grep -rn "mock-course\|useMockCourseProgress" app` — expect no output before deleting. Then delete both files.

- [ ] **Step 5: Manual verification**

Run `npm run dev` with `NEXT_PUBLIC_BACKEND_MODE=remote`, log in, open `/courses`, enroll in a real course, open a lesson, mark it complete, confirm the dashboard's `recentActivity` picks it up on next load (server-side, from Task 6). This cannot be a Jest test — it depends on a live server; do it manually and note the result in the PR description.

- [ ] **Step 6: Commit and open the PR**

```bash
git add app/hooks app/courses app/analysis
git commit -m "feat(courses): replace local mock course progress with real API

useMockCourseProgress/mock-course.ts were pure localStorage with zero
calls to the backend. Now that aivirteach-server implements courses/
enrollments/lessons/complete-lesson, this hook calls the real api.*
functions instead. Assessment grading (submitAssessment) is still not
implemented server-side, so answer-correctness tracking is dropped
from this hook until that exists."
```

Open the PR against `aivirteach-client`'s `main`, description should link to `aivirteach-server`'s commits from Part A and note the manual verification steps taken.

---

## Self-Review Notes

- **Spec coverage:** every model in the spec's schema block is used by at least one task (Auth models untouched/already covered by existing code; Course/CourseAsset/CourseVersion/CourseModule/CourseLesson/CourseWelcome/LessonAssessment/Enrollment/Progress/Attempt/Workspace/Conversation/Notification/PracticeSession/Activity/QuotaLedger/AuditEvent/EnrollmentCompletion all either read or written by Tasks 1–6). `Workspace`, `Conversation`, `EnrollmentCompletion`, and `LessonAssessment`'s write path are intentionally schema-only in this plan — they belong to Workspace orchestration (SRV-009/010/011) and assessment grading (blocked on `assessments.json`), both explicitly out of scope per the Global Constraints.
- **Type consistency check performed:** `EnrollmentResponse`, `CourseListItem`/`CourseDetailResponse`/`LessonResponse`, and `DashboardResponse` field names were cross-checked against each other (`computeProgressPercent`'s input shape matches what both `EnrollmentsService.listForUser` and `DashboardService.getDashboard` pass it; `courseId` is the slug everywhere it appears in a response).
- **No placeholders:** every step has real, complete code; the only intentionally-deferred pieces (assessment grading, asset serving, welcome ingestion, Console Session) are named explicitly in Global Constraints, not silently skipped.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-20-course-catalog-and-learning-api.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
