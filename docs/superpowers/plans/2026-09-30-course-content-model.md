# 课程内容模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运营能在草稿里改每一节课的正文，点"发版"后学员才看到；学员只读已发版，进度按课时 `contentId` 记。

**Architecture:** `CourseLesson.body` 存每节自己的 Markdown；草稿 = `publishedAt` 为空的 `CourseVersion`（整体复制生成，部分唯一索引保证每门课最多一份）。admin API（token 鉴权）写草稿，发版在一个事务里校验、重算汇总、应用课程元信息、重映射被删课时的学员进度、写审计。学员读课、目录、欢迎页、报名、进度、聊天全部改成"取最大的已发版"。

**Tech Stack:** NestJS 11、Prisma 6（PostgreSQL）、zod 4、jest（本仓库用 jest，不是 vitest，沿用现有）。不新增 npm 包。

**Spec:** `docs/superpowers/specs/2026-09-29-course-content-model-design.md`（含第 9 节"计划阶段补充的决定"，本计划按它执行）

工作分支：`feat/course-content-model`（执行时用 `superpowers:using-git-worktrees` 建）。提交信息格式 `<type>: <description>`，不加署名行（用户全局配置已关闭）。

## 修订（2026-10-01：课时块）

课时内容改存块 JSON，本计划按 `docs/superpowers/plans/2026-10-01-lesson-blocks.md`（下称"块计划"）修订。**执行本计划时先读这一节，它覆盖下面各任务里与之冲突的地方。**

- **路径：** 全部 `src/…`、`prisma/…`、`test/…` 改为 monorepo 迁移后的 `apps/api/src/…`、`apps/api/prisma/…`、`apps/api/test/…`；命令里的 `npm test -- …` 在 `apps/api` 下执行或加 `-w api`。monorepo 迁移（块计划任务 0）与块计划任务 1–4（`packages/lesson-blocks`）必须先完成。**执行顺序以块计划的"执行顺序"一节为准**，它把本计划各任务与块计划任务排成了一条线。
- **`content` 列：** 任务 2 的迁移 A 同时加 `CourseLesson.content Json?`（与 `body` 并存，`body` 作回退、迁移 B 删）。对比页多一行 `content`，Owen 关卡不变。
- **任务 3 摄取：** `sliceLessonBody` 保留（仍写 `body`），摄取同时转换并写 `content`——由块计划任务 7 完成；本任务只做切片部分。
- **任务 4 读课：** 本任务按原样做 `body`→`markdown`；`blocks`/`assets` 由块计划任务 8 在其上追加。
- **任务 7 回填：** 本任务只回填 `body` 与进度；`content` 回填由块计划任务 9 追加（同一个 service、同一条命令）。
- **任务 9 课时编辑：** `CreateLessonInput`/`UpdateLessonPatch` 里的 `body` 改为 `content?: unknown` 并做块校验、返回 `problems`——由块计划任务 10 完成；本任务先按原样实现其余部分，`body` 相关用例在块计划任务 10 里被替换。
- **任务 10 发版：** "每节 `body` 非空"由块计划任务 11 替换为"块校验无错误且至少一个会渲染的块"，并加首次发版规则。
- **任务 11 控制器：** 块计划任务 12、13 在同一个控制器文件上新增 `POST /admin/courses`、`GET /draft`、`POST /assets`。
- **任务 12 e2e：** 回填 dry-run 的检查点除 `body` 逐字一致外，还要看块计划任务 9 的 `content` 转换报告与纯文本等价结果，由 Owen 审阅；块计划任务 13 的 e2e 在同一次落库后执行。
- **新增 npm 包：** 本计划仍不新增；块计划新增 `unified`/`remark-*`/`mdast-util-to-string`（转换器，CLI 动态加载）和 `@types/multer`。

## Global Constraints

- 不新增 npm 包（块计划的转换器依赖除外，见上）；请求校验用 `zod` + `src/common/zod-validation.pipe.ts` 的 `ZodValidationPipe`。
- **数据库迁移执行前，先在可视化页面做前后对比，由 Owen 检查通过后才执行。不在未检查的情况下对任何数据库跑迁移**（本机 docker 库也算）。任务 3–11 全部用 mock 的单元测试，不需要数据库；`prisma generate` 不碰数据库，可以跑。
- 迁移 A 只加不删、可回滚；迁移 B 不可逆，观察期后才做，执行前先备份。
- 先写测试（RED），看它失败，再实现；覆盖率不低于 80%（`npm run test:cov`）。
- 学员读课、目录、欢迎页只认已发版：过滤 `publishedAt IS NOT NULL`，取最大版本。
- 一门课最多一个草稿：唯一索引 `(courseId) WHERE publishedAt IS NULL`，在迁移里写原生 SQL。
- `Progress` 用 `currentLessonContentId` 取代 `currentLessonId`；`Enrollment.courseVersionId` 保留为"报名时的版本"记录，不再决定读哪一版。
- admin API：`Authorization: Bearer $ADMIN_API_TOKEN`，缺失或错误 → 401；草稿不存在 → 404 并提示先创建草稿；发版校验失败 → 422 并返回完整问题列表，且不产生部分写入。
- `ADMIN_API_TOKEN` 必填、至少 32 个字符，加进 `src/config/env.ts` 的 `EnvSchema`；令牌比较用 `node:crypto` 的 `timingSafeEqual`。
- 已发版再点发版：无副作用（不写 `publishedAt`、不写审计）。
- 匹配现有风格：中文注释和报错信息、单引号、2 空格缩进、`prettier`。
- 每行改动都要能追溯到 spec，不顺手改别的。

## Review Focus

spec 没明说、但最可能咬到运营或学员的输入，按可能性排序；每条的测试在括号里的任务里。

1. 草稿版本号比已发版大时，学员读课/目录/欢迎页仍然拿到已发版（任务 4）。
2. 两个模块里出现同一个 `contentId`（数据库只保证"模块内唯一"）：`PATCH/DELETE /draft/lessons/:contentId` 返回 409 而不是改错一节；发版时报进问题列表（任务 9、10）。
3. 发版时删掉了某学员正停留的课时：进度落到"被删位置之后的下一节"，后面没有就落最后一节；已学完（指针为空）的学员不动（任务 10）。
4. 并发两次 `POST /draft`：第二个撞上唯一索引（P2002）时返回已有草稿，不报 500（任务 8）。
5. `Authorization` 头是 `Bearer `（空令牌）、长度和真令牌不同、或不是 `Bearer` 前缀：都是 401，不抛异常（任务 1）。

---

### Task 1: ADMIN_API_TOKEN 环境变量 + 守卫

**Files:**
- Modify: `src/config/env.ts`、`src/config/env.spec.ts`、`.env.example`
- Create: `src/admin/admin-api-token.guard.ts`、`src/admin/admin-api-token.guard.spec.ts`

**Interfaces:**
- Produces: `class AdminApiTokenGuard implements CanActivate`（构造注入 `@Inject(ENV) env: Env`）；`Env` 多一个 `ADMIN_API_TOKEN: string`。

- [ ] **Step 1: 写失败的测试**
  - `env.spec.ts`：`validSource` 加 `ADMIN_API_TOKEN: 'a'.repeat(32)`，默认值那条 `toEqual` 里加同名字段；新增 `缺少 ADMIN_API_TOKEN 时抛错并指名字段` 和 `ADMIN_API_TOKEN 太短时抛错并指名字段`（`toThrow(/ADMIN_API_TOKEN/)`）。
  - `admin-api-token.guard.spec.ts`（用 `ExecutionContext` 桩，`ENV.ADMIN_API_TOKEN = 't'.repeat(32)`）：正确令牌 → `true`；无 `authorization` 头、`Basic xxx`、`Bearer `（空）、`Bearer ` + 短令牌、`Bearer ` + 等长错令牌 → 全部抛 `UnauthorizedException`，且不抛别的异常类型。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/config/env.spec.ts src/admin/admin-api-token.guard.spec.ts`，预期 FAIL。
- [ ] **Step 3: 实现**
  - `env.ts`：`ADMIN_API_TOKEN: z.string().min(32, 'ADMIN_API_TOKEN 至少需要 32 个字符')`，放在 `JWT_SECRET` 下面。
  - `AdminApiTokenGuard.canActivate(context: ExecutionContext): boolean`：取 `Bearer ` 之后的令牌，两边各做一次 sha256 再 `timingSafeEqual`（避免长度不同时 `timingSafeEqual` 抛错、也不泄漏长度）；失败一律 `UnauthorizedException('缺少或无效的 admin 令牌')`。
  - `.env.example` 加 `ADMIN_API_TOKEN=`，注释写生成方式（同 `JWT_SECRET` 的 node 命令）和"绝不提交"。本机 `.env` 自己填一个值，不进提交。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2，预期 PASS；`npm test` 全量确认没有别的用例因 `loadEnv` 新增必填项而挂。
- [ ] **Step 5: 提交**：`git add src/config src/admin/admin-api-token.guard* .env.example && git commit -m "feat: add ADMIN_API_TOKEN env and admin api token guard"`

---

### Task 2: schema 变更 + 迁移 A（只写文件，不执行）+ 前后对比页（Owen 关卡）

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260930000000_course_content_model_a/migration.sql`
- Create: `../mockups/2026-09-30-migration-a-diff.html`（仓库根目录的 `mockups/`）

**Interfaces:**
- Produces（后续任务依赖的生成类型）：`CourseLesson.body: string`；`CourseLesson.sourceRange: Prisma.JsonValue | null`；`CourseVersion.meta: Prisma.JsonValue | null`；`Progress.currentLessonContentId: string | null`。

- [ ] **Step 1: 改 `schema.prisma`**：`CourseLesson` 加 `body String @default("") @db.Text`，`sourceRange Json` 改 `Json?`；`CourseVersion` 加 `meta Json?`（注释写明：草稿里的课程元信息，发版时应用到 `Course`）；`Progress` 加 `currentLessonContentId String?`。旧的 `currentLessonId`、`Enrollment.currentModuleId` 这一步不动。
- [ ] **Step 2: 手写 `migration.sql`**（不用 `migrate dev` 生成，避免它去连库）：四条 `ALTER TABLE`（`body`、`sourceRange DROP NOT NULL`、`meta`、`currentLessonContentId`）+ `CREATE UNIQUE INDEX "CourseVersion_one_draft_per_course" ON "CourseVersion"("courseId") WHERE "publishedAt" IS NULL;`。
- [ ] **Step 3: 校验不碰库**：`npx prisma validate && npx prisma generate && npx tsc --noEmit`，预期全部通过（`sourceRange` 变可空后 `getLesson` 里的 `as` 断言仍能编译）。
- [ ] **Step 4: 做前后对比页**：单个 HTML，图用 SVG（不用 CSS 拼），左"迁移前"右"迁移后"，逐表逐列标出新增/放宽/新索引；页内附三条执行前检查 SQL：①`SELECT "courseId", count(*) FROM "CourseVersion" WHERE "publishedAt" IS NULL GROUP BY 1 HAVING count(*) > 1`（必须无结果，否则唯一索引建不出来）；②`Progress` 里 `currentLessonId IS NOT NULL` 的行数（回填对账用）；③`CourseLesson` 总行数。
- [ ] **Step 5: 关卡——停下来**：把对比页路径给 Owen，等 Owen 明确说"通过"。**通过之前不许对任何库执行 `prisma migrate` / `db:migrate` / `db:reset`。** 通过后才允许做任务 12。
- [ ] **Step 6: 提交**：`git add prisma ../mockups/2026-09-30-migration-a-diff.html && git commit -m "feat: add course content model schema and migration A (not applied)"`

---

### Task 3: 每节正文切片 + 摄取时写入 `body`

**Files:**
- Create: `src/courses/lesson-body.ts`、`src/courses/lesson-body.spec.ts`
- Modify: `src/courses/course-ingestion.service.ts`、`src/courses/course-ingestion.service.spec.ts`

**Interfaces:**
- Produces: `sliceLessonBody(markdown: string, range: { startLine: number; endLine: number }): string`（行号从 1 起、闭区间，等价于旧 `getLesson` 的 `split('\n').slice(startLine - 1, endLine).join('\n')`）。任务 7 的回填复用它。

- [ ] **Step 1: 写失败的测试**
  - `lesson-body.spec.ts`：读 `__fixtures__/sample-course/lesson-source.md`，`lesson-1`（3–4 行）、`lesson-2`（5–6 行）的结果与"旧公式逐字相等"（测试里把旧公式内联写一遍当对照）；`endLine` 超过文件末尾时不抛错，返回旧公式同样的结果。
  - `course-ingestion.service.spec.ts`：`course.create` 的嵌套 lessons 里每节带 `body`，值等于对应切片；`sourceMarkdown` 和 `sourceRange` 仍然照旧写入。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/courses/lesson-body.spec.ts src/courses/course-ingestion.service.spec.ts`，预期 FAIL。
- [ ] **Step 3: 实现** `sliceLessonBody`，并在摄取的 `lessons.create` map 里加 `body: sliceLessonBody(sourceMarkdown, lesson.sourceRange)`。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: slice each lesson body at ingestion"`

---

### Task 4: 学员只读已发版 + 读课改读 `body` + 草稿预览共用响应构造

**Files:**
- Create: `src/courses/published-version.ts`、`src/courses/lesson-response.ts`、`src/courses/lesson-response.spec.ts`
- Modify: `src/courses/courses.service.ts`、`src/courses/courses.service.spec.ts`

**Interfaces:**
- Produces:
  - `LATEST_PUBLISHED_VERSION`：可直接放进 Prisma `include.versions` 的常量，内容为 `{ where: { publishedAt: { not: null } }, orderBy: { version: 'desc' }, take: 1, include: { modules: { orderBy: { position: 'asc' }, include: { lessons: { orderBy: { position: 'asc' } } } }, welcome: true } }`，用 `satisfies Prisma.Course$versionsArgs`。任务 5、6 复用。
  - `buildLessonResponse(input: { courseSlug: string; modules: Array<ModuleRow & { lessons: LessonRow[] }>; lessonId: string }): LessonResponse`：找不到课时抛 `NotFoundException(\`课程 ${slug} 里找不到课时：${lessonId}\`)`；`markdown` 取 `lesson.body`。`LessonResponse` 类型移到这里，`courses.service.ts` 里 `export type { LessonResponse }` 转出，调用方不用改 import。任务 11 的草稿预览用它。

- [ ] **Step 1: 写失败的测试**
  - `lesson-response.spec.ts`：给两节课的 `body`，返回的 `markdown` 等于 `body`；`navigation` 的 `previousLessonId/nextLessonId/index/total` 正确；`contentId` 不存在 → `NotFoundException`。
  - `courses.service.spec.ts`：`findUnique` 的 `include.versions` 与 `LATEST_PUBLISHED_VERSION` 深度相等（`getDetail`/`getWelcome`/`getLesson` 三个入口各一条）；`getLesson` 返回的 `markdown` 来自 `body`，mock 数据里 `sourceMarkdown`/`sourceRange` 故意给不一致的值以证明不再读它们；`versions` 为空数组 → `NotFoundException`。
  - Review-focus（1）：mock 返回的 `versions[0]` 是已发版那份，断言 query 的 `where.publishedAt` 是 `{ not: null }`——草稿不会被查出来。真库验证在任务 12。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/courses`，预期 FAIL。
- [ ] **Step 3: 实现**：新建两个文件；`courses.service.ts` 把 `COURSE_WITH_LATEST_VERSION_INCLUDE` 换成 `{ versions: LATEST_PUBLISHED_VERSION }`，`getLesson` 改调 `buildLessonResponse`，删掉 `sourceLines`/`sourceRange` 的旧逻辑。
- [ ] **Step 4: 跑测试确认通过**：`npm test -- src/courses`，预期 PASS。
- [ ] **Step 5: 提交**：`git commit -m "fix: learners read only the latest published version and lesson body"`

---

### Task 5: 进度按 `contentId`（enrollment-view、enrollments、dashboard）

**Files:**
- Modify: `src/enrollments/enrollment-view.ts`、`src/enrollments/enrollments.service.ts`、`src/dashboard/dashboard.service.ts`，以及各自的 `*.spec.ts`

**Interfaces:**
- Consumes: 任务 4 的 `LATEST_PUBLISHED_VERSION`。
- Produces（`enrollment-view.ts`，全部改成以 `contentId` 为键）：
  - `type ProgressPointer = { currentLessonContentId: string | null } | null`；`type ModulesWithLessons = Array<{ title: string; lessons: Array<{ contentId: string }> }>`
  - `deriveEnrollmentStatus(input: { completedAt: Date | null; currentLessonContentId: string | null }): EnrollmentStatus`
  - `computeProgressPercent(enrollment: { progress: ProgressPointer; modules: ModulesWithLessons }): number`
  - `deriveCurrentModuleTitle(input: { progress: ProgressPointer; modules: ModulesWithLessons }): string`（指针为空或找不到 → `''`）
  - `deriveEnrollmentView` 签名不变。

- [ ] **Step 1: 写失败的测试**
  - `enrollment-view.spec.ts`：现有用例的 `currentLessonId`/`id` 全换成 `currentLessonContentId`/`contentId`；新增 `deriveCurrentModuleTitle`：指针在第二个模块的课时上 → 返回第二个模块的标题；指针为 `null` → `''`；指针不在任何模块 → `''`。
  - `enrollments.service.spec.ts`：`enroll`/`restart` 写入的 `courseVersionId` 是最大已发版的 id，`restart` 的 `update` 里不再有 `currentModuleId`、`progress.upsert` 用 `currentLessonContentId: null`；`listForUser`/`completeLesson` 查课时用 `course.versions`（`LATEST_PUBLISHED_VERSION`）而不是 `enrollment.courseVersion`；`completeLesson` 写入 `progress.upsert` 的是下一节的 `contentId`，学完最后一节写 `null` 并同时写 `completedAt`（现有断言改键名保留）；报名后 `enrollment.courseVersionId` 指向旧版本时，读的仍是最新已发版（spec 第 3 节第 6 条）。
  - `dashboard.service.spec.ts`：活跃报名的课时来自 `course.versions[0]`，`currentModule` 由 `deriveCurrentModuleTitle` 算出。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/enrollments src/dashboard`，预期 FAIL。
- [ ] **Step 3: 实现**：三个文件按上面签名改。`enrollments.service.ts` 的 `include` 由 `courseVersion: {...}` 改为 `course: { include: { versions: LATEST_PUBLISHED_VERSION } }`；`toResponse` 的 `currentModule` 用 `deriveCurrentModuleTitle`，去掉对 `enrollment.currentModule` 的读取和 `include: { currentModule: true }`；`dashboard.service.ts` 同理。`Enrollment.courseVersionId` 的写入保留，取值改为"最大已发版的 id"（`requirePublishedCourseWithLatestVersion` 已经保证）。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2，预期 PASS；`npx tsc --noEmit` 只应剩 `chat.service.ts` 的报错（任务 6 处理）。
- [ ] **Step 5: 提交**：`git commit -m "refactor: track learner progress by lesson contentId"`

---

### Task 6: 聊天诊断上下文按 `contentId` 定位课时

**Files:**
- Modify: `src/chat/chat.service.ts`、`src/chat/chat.service.spec.ts`

**Interfaces:**
- Consumes: 任务 4 的 `LATEST_PUBLISHED_VERSION`。
- Produces: `buildDiagnoseContext(courseId: string, currentLessonContentId: string)`（私有），行为与旧版一致，只是课时改为"该课程最大已发版里 `contentId` 相等的那一节"。

- [ ] **Step 1: 写失败的测试**：`progress.currentLessonContentId` 为 `null` → 仍走"还没有开始学习课程内容"的兜底文案；有值 → 诊断请求里的 `current_step.lesson_id` 等于该 `contentId`、`sequence` 是它在已发版课时里的序号、`course.version` 是最大已发版的版本号；`contentId` 在已发版里已不存在 → 走同一个兜底文案，不抛错。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/chat`，预期 FAIL。
- [ ] **Step 3: 实现**：`resolveDiagnoseRequest` 用 `progress.currentLessonContentId`；`buildDiagnoseContext` 改为 `course.findUnique({ where: { id: courseId }, include: { versions: LATEST_PUBLISHED_VERSION } })` 后在内存里按 `contentId` 找课时并取它的 `assessments`（需要在 include 里补 `assessments`，用 `lessons: { include: { assessments: true } }` 覆盖，不改共用常量）。`courseId` 来自该 enrollment 的 `courseId`。
- [ ] **Step 4: 跑测试确认通过**：`npm test -- src/chat`；`npx tsc --noEmit` 预期零报错。
- [ ] **Step 5: 提交**：`git commit -m "refactor: resolve chat diagnose lesson by contentId"`

---

### Task 7: 回填命令 `course:backfill-content-model`

**Files:**
- Create: `src/admin/backfill/content-model-backfill.service.ts`、`.spec.ts`
- Create: `src/admin/commands/course-backfill.command.ts`、`.spec.ts`
- Modify: `src/admin/admin.module.ts`（注册 provider）

**Interfaces:**
- Consumes: 任务 3 的 `sliceLessonBody`。
- Produces: `ContentModelBackfillService.run(options: { execute: boolean }): Promise<BackfillReport>`；`type BackfillReport = { bodies: { filled: number; unresolved: Array<{ lessonId: string; reason: string }> }; progress: { filled: number; total: number } }`。可重复运行：只处理 `body = ''` 且所属版本有 `sourceMarkdown` 的课时、只处理 `currentLessonContentId IS NULL` 且 `currentLessonId IS NOT NULL` 的进度。`execute: false` 只统计不写库。

（选 TS 命令而不是把回填塞进迁移 SQL：迁移保持纯 DDL，Owen 的对比页只需看结构；切片逻辑能脱库做单元测试；沿用现有 CLI 的 `--execute` 约定。）

- [ ] **Step 1: 写失败的测试**
  - service：mock 一个版本（`sourceMarkdown` 取 sample-course 的文件内容）+ 两个 `body=''` 的课时 → `execute:true` 时 `courseLesson.update` 被调两次且 `body` 与 `sliceLessonBody` 逐字一致；`execute:false` → 不调 `update`，但 `filled` 统计相同；`sourceMarkdown` 为 `null` 的版本 → 进 `unresolved`（`reason: '版本没有 sourceMarkdown'`），不静默丢；已有非空 `body` 的课时不被覆盖（可重复运行）；进度：`currentLessonId` 指向的课时行的 `contentId` 被写进 `currentLessonContentId`，`filled` 与 `total`（有旧指针的行数）一致。
  - command：不带 `--execute` 只打印报告 JSON 且不写；带 `--execute` 才写；`--operator`/`--reason` 必填（沿用 `OperatorSchema`/`ReasonSchema`），执行时记一条 `admin.backfillContentModel` 审计。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/admin/backfill src/admin/commands/course-backfill`，预期 FAIL。
- [ ] **Step 3: 实现**，输出格式仿 `course.command.ts` 的 JSON 一行。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: add idempotent backfill command for lesson body and progress contentId"`

---

### Task 8: 草稿——创建 / 丢弃 / 元信息 / 欢迎页

**Files:**
- Create: `src/admin/draft/draft-version.ts`、`src/admin/draft/draft.schemas.ts`
- Create: `src/admin/draft/course-draft.service.ts`、`.spec.ts`

**Interfaces:**
- Produces:
  - `DRAFT_INCLUDE`（`{ modules: { orderBy: { position: 'asc' }, include: { lessons: { orderBy: { position: 'asc' }, include: { assessments: true } } } }, welcome: true }`）与 `type DraftVersion = Prisma.CourseVersionGetPayload<{ include: typeof DRAFT_INCLUDE }>`。任务 9、10、11 复用。
  - `CourseDraftService`：
    - `createDraft(slug: string, operator: string): Promise<{ draft: DraftVersion; created: boolean }>`：从最大已发版整体复制（版本号 = 该课程最大版本号 + 1；复制模块、课时含 `body`/`assessmentIds`、欢迎页、每节的 `LessonAssessment`；`imageDigest`/`sourceFormat`/`sourcePath`/`sourceEncoding`/`introFeaturedAssetIds` 照抄，`sourceMarkdown`、`meta` 不抄；`CourseAsset` 不复制）；已有草稿 → `created: false` 直接返回；没有已发版可复制 → `NotFoundException`。
    - `discardDraft(slug: string, operator: string): Promise<void>`（无草稿 → 404）
    - `requireDraft(slug: string): Promise<DraftVersion>`（无草稿 → `NotFoundException('课程 ${slug} 没有草稿，请先 POST /admin/courses/${slug}/draft 创建')`）
    - `updateCourse(slug: string, patch: CourseMetaPatch, operator: string): Promise<DraftVersion>`：合并写入 `CourseVersion.meta`，**不碰 `Course` 表**。
    - `updateWelcome(slug: string, patch: WelcomePatch, operator: string): Promise<DraftVersion>`：没有欢迎页行时创建。
  - `draft.schemas.ts`：`CourseMetaPatchSchema`（`title`、`shortTitle`、`category`、`description`、`level`（`Beginner|Intermediate|Advanced`，存入前用 `mapCourseLevel` 转成枚举字符串）、`language`、`tags`、`outcomes`、`requirements`，全部可选，`.strict()`）、`WelcomePatchSchema`（`overviewAssetId`、`overviewHeading`、`overviewParagraphs`、`howItWorksSteps`、`finalOutcome`，全部可选，`.strict()`）；导出 `type CourseMetaPatch`、`type WelcomePatch`。
  - 每个写操作都记 `AuditEvent`：actor `OPERATOR`（id = `operator`），action 依次为 `admin.draft.create` / `admin.draft.discard` / `admin.draft.updateCourse` / `admin.draft.updateWelcome`，`targetType: 'CourseVersion'`，`targetId` 为草稿版本 id，`metadata: { slug }`。

- [ ] **Step 1: 写失败的测试**
  - 复制：mock 已发版 v2（2 模块 3 课时含 `body`、有欢迎页、有测评题）→ `courseVersion.create` 的嵌套 data 含全部课时的 `body`、版本号 3、`publishedAt` 未设置、不含 `sourceMarkdown`；已有草稿 → `created:false` 且不调 `create`；`CourseAsset` 相关的 `create` 一次都不调。
  - Review-focus（4）：`courseVersion.create` 抛 `Prisma.PrismaClientKnownRequestError` code `P2002` → 重新查草稿并返回 `created:false`，不抛。
  - `updateCourse`：不存在的字段被 `CourseMetaPatchSchema` 拒绝（`level: 'Expert'` 抛错）；只往 `courseVersion.update` 写 `meta`，`course.update` 从不被调用；连续两次 patch 合并而不是覆盖。
  - `requireDraft`/`discardDraft` 无草稿 → 404，文案含"请先"。
  - 每个写操作各断言一条对应的审计 action。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/admin/draft`，预期 FAIL。
- [ ] **Step 3: 实现**：复制用一次 `prisma.$transaction` 里的嵌套 `create`；`P2002` 捕获用 `error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'`（同 `course-ingestion.service.ts`）。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: add course draft creation, discard, meta and welcome edits"`

---

### Task 9: 草稿——模块、课时、顺序、测评题

**Files:**
- Create: `src/admin/draft/draft-content.service.ts`、`.spec.ts`
- Modify: `src/admin/draft/draft.schemas.ts`

**Interfaces:**
- Consumes: 任务 8 的 `CourseDraftService.requireDraft`、`DraftVersion`。
- Produces：`DraftContentService`（下列方法都以 `slug` 找草稿，最后一个参数是 `operator: string`，都返回更新后的 `DraftVersion`，审计 action 为 `admin.draft.<方法名>`）：
  - `createModule(slug, input: CreateModuleInput, operator)`、`updateModule(slug, moduleId, patch: UpdateModulePatch, operator)`、`deleteModule(slug, moduleId, operator)`
  - `createLesson(slug, moduleId, input: CreateLessonInput, operator)`、`updateLesson(slug, contentId, patch: UpdateLessonPatch, operator)`、`deleteLesson(slug, contentId, operator)`
  - `reorder(slug, input: ReorderInput, operator)`、`updateAssessment(slug, assessmentId, patch: UpdateAssessmentPatch, operator)`
  - 私有约定：`contentId` 路径参数在草稿内匹配 0 节 → `NotFoundException`，匹配多节（不同模块里同名）→ `ConflictException`，文案列出这些模块的标题。
- Produces（`draft.schemas.ts` 新增，全部 `.strict()`）：`CreateModuleInput = { title, description, estimatedMinutes }`；`UpdateModulePatch` = 其可选版本；`CreateLessonInput = { contentId: string (kebab-case 非空), title, body?, estimatedMinutes, objectives?, activity: { type, prompt, completionType } }`；`UpdateLessonPatch` = 除 `contentId` 外的可选版本（**`contentId` 创建后不可改**，否则学员进度会失联）；`ReorderInput = { modules: Array<{ id: string; lessons: string[] }> }`（`lessons` 是 `contentId` 数组）；`UpdateAssessmentPatch` = `type/question/options/clientCriteria/expectedResult/successCriteria/commonFailures` 的可选版本。

- [ ] **Step 1: 写失败的测试**
  - 新增模块/课时追加到末尾（`position` = 现有最大值 + 1）；新课时的 `body` 默认 `''`。
  - 删除模块/课时后同级剩余项的 `position` 重排为 1..n。
  - `reorder`：提交的模块 id 和课时 `contentId` 必须恰好是草稿现有全集的一个排列（缺一、多一、重复都 → `BadRequestException`）；允许把课时移到别的模块；结果 `position` 为 1..n。
  - `updateLesson` 的 patch 含 `contentId` → schema 拒绝。
  - Review-focus（2）：草稿里模块 A、B 各有 `contentId: 'setup'`，`updateLesson('sample', 'setup', …)` 与 `deleteLesson` → `ConflictException`，且没有任何写库调用。
  - 找不到草稿 → 404（沿用 `requireDraft`）；每个方法记对应审计。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/admin/draft`，预期 FAIL。
- [ ] **Step 3: 实现**：`reorder` 在一个事务里先把涉及行的 `position` 整体加一个大偏移再写目标值，避开 `@@unique([moduleId, position])` 的中间态冲突。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: add draft module, lesson, order and assessment edits"`

---

### Task 10: 发版（校验、汇总、元信息、进度重映射、审计）

**Files:**
- Create: `src/admin/draft/publish-validation.ts`、`.spec.ts`
- Create: `src/admin/draft/progress-remap.ts`、`.spec.ts`
- Create: `src/admin/draft/course-publish.service.ts`、`.spec.ts`
- Modify: `src/admin/admin.service.ts`（`publishCourse` 改为委托）、`src/admin/admin.service.spec.ts`、`src/admin/admin.module.ts`

**Interfaces:**
- Consumes: 任务 8 的 `DraftVersion`、`DRAFT_INCLUDE`、`CourseMetaPatchSchema`。
- Produces:
  - `validateDraftForPublish(input: { draft: DraftVersion; courseAssetIds: ReadonlySet<string>; coverAssetId: string | null }): string[]`（纯函数，返回全部问题的中文描述，空数组 = 通过）。规则：至少 1 节课；每节 `body` 去空白后非空；课时 `contentId` 在**整个版本**内不重复；模块 `position` 与每个模块内课时 `position` 都是 1..n 连续；`coverAssetId` 与 `welcome.overviewAssetId`（非空时）必须在 `courseAssetIds` 里；`meta`（非空时）必须通过 `CourseMetaPatchSchema`。`introFeaturedAssetIds` 不校验（现存值是作者侧素材名，不是 `CourseAsset.id`）。
  - `remapRemovedLessons(oldOrder: string[], newOrder: string[]): Map<string, string>`（纯函数）：对每个在 `oldOrder` 但不在 `newOrder` 的 `contentId`，映射到它在旧顺序里之后第一个仍在 `newOrder` 的课时；后面没有则映射到 `newOrder` 的最后一个；`newOrder` 为空则不产生映射。
  - `CoursePublishService.publish(slug: string, operator: string, reason?: string): Promise<CourseVersion>`：
    1. 最大版本已发版且不存在草稿 → 直接返回它，无任何写入、无审计；
    2. 否则取草稿，`validateDraftForPublish` 有问题 → `UnprocessableEntityException({ message: '草稿校验未通过', problems })`，不写库；
    3. 一个 `$transaction` 内：`Course.lessonCount` = 课时总数、`Course.durationMinutes` = 各课时 `estimatedMinutes` 之和；`meta` 非空则合并到 `Course`；`Course.published = true`；对旧的最大已发版与草稿调用 `remapRemovedLessons`，用 `progress.updateMany({ where: { currentLessonContentId: <被删 id>, enrollment: { courseId } }, data: { currentLessonContentId: <新 id> } })` 改写；`courseVersion.updateMany({ where: { id, publishedAt: null }, data: { publishedAt: new Date() } })`；
    4. 事务提交后记 `AuditEvent`：action `admin.publishCourse`，`targetType: 'CourseVersion'`，`targetId` = 发布的版本 id，`reason`，`metadata: { slug, version }`。
  - `AdminService.publishCourse(slug, operator, reason)` 改为委托给 `CoursePublishService.publish`（CLI `course:publish` 复用同一套校验；CLI 命令文件不改）。

- [ ] **Step 1: 写失败的测试**
  - `publish-validation.spec.ts`：合法草稿 → `[]`；同时存在"空 body + 重复 contentId + position 断档 + 封面不存在 + meta 非法"→ 一次返回 5 条；零课时 → 含"至少需要一节课"；`introFeaturedAssetIds: ['cover']` 不产生问题。
  - `progress-remap.spec.ts`：旧 `[a,b,c,d]`、新 `[a,c,d]` → `b→c`；旧 `[a,b,c]`、新 `[a,b]` → `c→b`（落最后一节）；旧 `[a,b]`、新 `[x,y]`（全换）→ `a→y`、`b→y`；未删除的不出现在映射里；新顺序为空 → 空映射。
  - `course-publish.service.spec.ts`：校验失败 → 422、`problems` 完整、`$transaction` 从未被调用；成功 → `Course.lessonCount`/`durationMinutes` 按草稿重算、`published: true`、`meta` 被应用、`publishedAt` 只在 `publishedAt: null` 的条件下写；再次调用（最大版本已发版、无草稿）→ 返回该版本、无 `$transaction`、无审计；成功路径恰好一条 `admin.publishCourse` 审计且发生在事务之后。
  - Review-focus（3）：旧版有 `[a,b,c]`、草稿删了 `b`，`Progress` 里 `b` 的学员被 `updateMany` 改到 `c`；`completedAt` 已设置且指针为 `null` 的学员不会被任何 `updateMany` 命中（`where` 里指定了具体 `currentLessonContentId`，不含 `null`）。
  - `admin.service.spec.ts`：`publishCourse` 委托 `CoursePublishService.publish` 且原有 CLI 审计断言相应调整。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/admin`，预期 FAIL。
- [ ] **Step 3: 实现**。校验函数与重映射函数保持纯函数，`publish` 只做取数、调用、事务与审计。
- [ ] **Step 4: 跑测试确认通过**：`npm test -- src/admin`，预期 PASS。
- [ ] **Step 5: 提交**：`git commit -m "feat: publish course drafts with validation, summary and progress remap"`

---

### Task 11: admin API 控制器 + 模块接线 + 草稿预览

**Files:**
- Create: `src/admin/admin-courses.controller.ts`、`src/admin/admin-courses.controller.spec.ts`
- Modify: `src/admin/admin.module.ts`（加 `controllers`、`providers`）

**Interfaces:**
- Consumes: 任务 1 的 `AdminApiTokenGuard`；任务 4 的 `buildLessonResponse`；任务 8–10 的三个服务。
- Produces：`@Controller('admin/courses/:slug')`（全局前缀 `api/v1` 由 `main.ts` 加，最终路径 `/api/v1/admin/courses/:slug/...`），类上 `@UseGuards(AdminApiTokenGuard)`、`@ApiBearerAuth()`、`@ApiTags('Admin')`。路由与 spec 第 4 节的表一一对应：`POST/DELETE/PATCH /draft`、`PATCH /draft/welcome`、`POST /draft/modules`、`PATCH|DELETE /draft/modules/:moduleId`、`POST /draft/modules/:moduleId/lessons`、`PATCH|DELETE /draft/lessons/:contentId`、`PUT /draft/order`、`PATCH /draft/assessments/:assessmentId`、`GET /draft/lessons/:contentId`（预览）、`POST /publish`。
  - 所有写路由要求请求头 `X-Operator`（用 `OperatorSchema` 经 `ZodValidationPipe` 校验，缺失或非邮箱 → 400）；`POST /publish` 的 body 可选 `{ reason?: string }`。
  - 请求体统一走 `ZodValidationPipe(<Schema>)`。
  - `POST /draft` 新建返回 201、已有草稿返回 200（用 `@Res({ passthrough: true })` 或由 service 的 `created` 决定状态码）。
  - `GET /draft/lessons/:contentId`：`requireDraft` 后调用 `buildLessonResponse({ courseSlug: slug, modules: draft.modules, lessonId: contentId })`，结构与学员读课接口完全一致。

- [ ] **Step 1: 写失败的测试**（用 `supertest` + `Test.createTestingModule` + `app.init()`，服务层用桩）
  - 每条路由：无 `Authorization` → 401、错令牌 → 401、正确令牌 → 委托到对应服务方法且参数正确。
  - 写路由缺 `X-Operator` → 400；`POST /draft` 新建 201 / 已有 200。
  - 预览：同一份数据经预览接口和 `buildLessonResponse` 得到的 JSON 深度相等；`contentId` 不存在 → 404。
  - 发版校验失败 → 422 且响应体含完整 `problems`。
- [ ] **Step 2: 跑测试确认失败**：`npm test -- src/admin/admin-courses.controller.spec.ts`，预期 FAIL。
- [ ] **Step 3: 实现**，并在 `AdminModule` 注册 `CourseDraftService`、`DraftContentService`、`CoursePublishService`、`AdminApiTokenGuard`。
- [ ] **Step 4: 跑测试确认通过**：`npm test`（全量）与 `npx tsc --noEmit`、`npm run lint`，预期全部通过。
- [ ] **Step 5: 提交**：`git commit -m "feat: expose admin course draft api with token guard and lesson preview"`

---

### Task 12: 迁移 A 落库 + 真库验证（前提：Owen 已在任务 2 的关卡通过）

**Files:**
- Create: `test/course-content-model.e2e-spec.ts`

- [ ] **Step 1: 确认前提**：Owen 已通过对比页；本机 `docker compose up -d` 已起库；先跑对比页里的三条检查 SQL，记录结果。
- [ ] **Step 2: 执行迁移 A**：`npx prisma migrate deploy`（应用手写的 SQL，不生成新迁移）。随后 `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` 确认部分唯一索引没有被 Prisma 判成漂移；如果它报要删这个索引，停下来告诉 Owen，不要自己改。
- [ ] **Step 3: 写 e2e**（真库，仿 `test/schema.e2e-spec.ts`，用后清理自己造的数据）：
  - 用 `sample-course` 摄取后，每节 `body` 与旧公式切片逐字一致（迁移用例）。
  - 建已发版 v1 + 草稿 v2（改了 `body`）→ 学员读课/目录/欢迎页拿到 v1，草稿怎么改学员都拿不到（可见性用例，Review-focus 1 的真库版）。
  - 第二份草稿 `INSERT` 违反唯一索引；发版后可再建新草稿。
  - 发版：汇总被重算；重复发版无副作用；写了审计；删课时后学员进度落点正确（含"删最后一节"、"调顺序"、"加课时"）。
  - admin API：无令牌、错令牌 401。
- [ ] **Step 4: 跑回填与全量验证**：`npm run cli -- course:backfill-content-model -o <邮箱> -r "迁移A回填"` 先 dry-run，核对 `progress.filled === progress.total`、`bodies.unresolved` 为空或有已知解释；再加 `--execute`；重跑一次确认 `filled` 为 0（可重复运行）。然后 `npm test`、`npm run test:e2e`、`npm run test:cov`（覆盖率 ≥ 80%）、`npm run build`。
- [ ] **Step 5: 部署提醒**：线上（Vercel）先配 `ADMIN_API_TOKEN` 再发布，否则服务启动即崩（`vercel env add ADMIN_API_TOKEN`）。线上迁移同样需要 Owen 对着对比页再确认一次，不在本任务里执行。
- [ ] **Step 6: 提交**：`git add test && git commit -m "test: add course content model e2e coverage"`

---

### Task 13: 迁移 B（不可逆，观察期后才做——本计划只写下来，不执行）

**Files:**
- Modify: `prisma/schema.prisma`；Create: `prisma/migrations/<日期>_course_content_model_b/migration.sql`

- [ ] **Step 1: 前提**：迁移 A 与代码切换已上线并观察一段时间，Owen 明确说"可以做 B"；先备份数据库。
- [ ] **Step 2**：删除 `Progress.currentLessonId`（含外键与索引）和 `Enrollment.currentModuleId`（含外键与索引）；`schema.prisma` 同步删字段与两个 relation；`npx prisma validate && npx prisma generate && npx tsc --noEmit && npm test` 全部通过。
- [ ] **Step 3**：像迁移 A 一样先出前后对比页，Owen 通过后才执行。
- [ ] **Step 4: 提交**：`git commit -m "feat: drop legacy progress lesson id and enrollment current module"`
