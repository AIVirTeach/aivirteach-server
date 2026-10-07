# 运营后台 4b：课程列表、块编辑器、预览与发版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运营在管理后台里从新建课程到发版全程不用 CLI：课程列表与新建、课程元信息与模块 / 课时树、块编辑器（块卡片 + 属性面板 + 自动保存 + 撤销重做 + 图片素材上传）、client 真实渲染预览、测评题、发版与丢弃草稿。

**Architecture:** `apps/api` 只补两个读接口（课程列表、素材列表），其余草稿 / 发版 / 素材上传接口第 1 块已有。`apps/admin` 用 Server Component 读、Server Action 写；块编辑器是客户端组件，但它的保存、上传也走 Server Action，浏览器 JS 不直接调 Nest。编辑器的状态逻辑（块增删排序、撤销重做、自动保存状态机）抽成**纯函数 / reducer**，与 React 分开测。属性表单由 `BLOCK_REGISTRY` 的 zod schema 生成。预览是 iframe 嵌 client 的 `/preview/lesson`，用 `postMessage` 通信。

**Tech Stack:** NestJS 11、Prisma 6、zod 4、Jest 30；Next.js 16 App Router、React 19、Tailwind、shadcn/ui、vitest + Testing Library。

**Spec:** `docs/superpowers/specs/2026-10-01-admin-console-design.md` 第 6（课程页、编辑器）、7、9、10 节；`docs/superpowers/specs/2026-10-01-lesson-blocks-design.md` 第 4、6、7、9、12 节。

**前置：**
- 4a 已合并（`OperatorAuthGuard`、`@CurrentOperator()`、`packages/admin-contract`、`apps/admin` 登录壳、`apiFetch`）。**4a 在 server PR #24，截至本计划写成时未合并。**
- client 的块渲染器与 `/preview/lesson` 已合并（client PR #14，2026-10-07）。预览页的约定：收到 `{ type: "lesson-preview", lesson: { title, moduleTitle, blocks }, assets, problems }` 才渲染；加载后向父窗口发 `{ type: "lesson-preview-ready" }`；只信 `NEXT_PUBLIC_ADMIN_ORIGIN` 对应来源。
- 与 4c 互不依赖，可并行。

## Global Constraints

- 浏览器里的 JS 不直接请求 Nest：读用 Server Component，写（含自动保存、上传）用 Server Action；`apps/admin` 不引用 `JWT_SECRET`、`DATABASE_URL`。
- 块的定义只来自 `@aivirteach/lesson-blocks`（`BLOCK_TYPES`、`BLOCK_REGISTRY`、`validateLessonContent`）；admin 不自己写块 schema，也不自己渲染块。
- 自动保存：修改后防抖 800 ms 提交 `PATCH /admin/courses/:slug/draft/lessons/:contentId`（body 只带 `content`）；状态只有 `idle | dirty | saving | saved | failed`；`failed` 时保留本地改动，并拦截离开页面。有校验错误的内容照存，响应里的 `problems` 显示在对应卡片上。
- 撤销 / 重做至少 50 步；撤销历史只在内存里，刷新即清空。
- 块 `id` 在课时内唯一、创建后不变（1–64 字符）；一节课最多 300 个块（达到上限时禁用「添加」）。
- 预览只向 `NEXT_PUBLIC_CLIENT_ORIGIN` 发消息；收到 `lesson-preview-ready` 之前不发；client 不可用（5 秒内没有 ready）显示「预览不可用」，不影响编辑和保存。
- 图片素材：仅 png / jpeg / webp / gif，≤ 5 MB（后端已校验，前端提前拦一次并显示后端文案）；`next.config.ts` 的 Server Action 请求体上限调到 6 MB。
- 发版失败（422）把 `problems` 完整列出，不截断；发版成功提示「N 名在学学员会立刻看到新版」。
- 401：Server Component 里沿用 `apiFetch` 跳转登录；**保存 / 上传这类 Server Action 不能跳转**（会丢掉未保存的改动），返回 `{ status: "unauthorized" }`，编辑器保留本地内容并提示重新登录。
- 本块无数据库迁移。
- 代码风格：文件 200–400 行、上限 800；匹配现有风格；先写测试；覆盖率不低于 80%；lint 用 `npx eslint --no-fix`；跑 e2e 前显式传本地 `DATABASE_URL`；提交格式 `<type>: <description>`。

## Review Focus

- **保存进行中又发生了编辑：** 旧请求的响应不能覆盖较新的本地内容，也不能让这次编辑丢失；保存顺序按发出顺序，最终状态是「最后一次编辑已保存」。（Task 4）
- **编辑中会话过期（8 小时）：** 保存返回 `unauthorized`，页面不跳转、本地改动还在，重新登录后可以继续保存。（Task 4、8）
- **图片块默认 `assetId` 为空：** 刚添加的图片块显示后端给的 `problems`，不崩溃；选了别的课程的素材 id 被发版校验拦下，编辑器显示该错误。（Task 5、6）
- **两位运营同时编辑同一节课：** 接口没有版本号，后写覆盖先写。v1 不处理，保存成功后不提示；这是已知限制，要在 README 里写明。（Task 8）
- **预览：** client 离线、域名配错、预览页尚未 ready 就有改动：不报错、不向错误来源发消息，ready 后补发最新内容。（Task 7）
- **发版 422：** 问题列表很长（几十条）时仍能完整查看，并能从问题定位到具体课时。（Task 3）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/src/admin/courses/admin-course-list.service.ts`（新） | `GET /admin/courses`：课程列表聚合 |
| `apps/api/src/admin/assets/course-asset-list.service.ts`（新） | `GET /admin/courses/:slug/assets`：素材列表（含公开地址） |
| `packages/admin-contract/src/courses.ts`（新） | 课程列表、素材、草稿树、保存结果、发版错误的 zod schema 与类型 |
| `apps/admin/lib/courses-api.ts`（新） | 上述接口的类型化读取函数（走 `apiFetch`） |
| `apps/admin/lib/api-client.ts`（改） | 增加不跳转的 `apiFetchNoRedirect`，供保存 / 上传用 |
| `apps/admin/app/(app)/courses/`（新） | `/courses`、`/courses/[slug]` 页面与 Server Action |
| `apps/admin/app/(app)/courses/[slug]/lessons/[contentId]/`（新） | 编辑器页面（三栏装配） |
| `apps/admin/components/editor/editor-state.ts`（新） | 块列表 reducer、撤销重做、块 id 生成（纯函数） |
| `apps/admin/components/editor/autosave.ts`（新） | 自动保存状态机（纯函数 + 薄 hook） |
| `apps/admin/components/editor/block-card.tsx`、`block-form.tsx`（新） | 块卡片、由 schema 生成的属性表单 |
| `apps/admin/components/editor/asset-picker.tsx`（新） | 上传 / 从本课程素材中选择 |
| `apps/admin/components/editor/preview-frame.tsx`（新） | iframe + `postMessage` 通道 |
| `apps/admin/components/courses/`（新） | 课程列表、元信息表单、模块 / 课时树、发版对话框 |

---

### Task 1: API —— 课程列表 `GET /admin/courses`

**Files:**
- Create: `apps/api/src/admin/courses/admin-course-list.service.ts`、同名 `.spec.ts`
- Modify: `apps/api/src/admin/admin-courses.controller.ts`（`AdminCourseCreateController` 增加 `@Get()`）、`apps/api/src/admin/admin.module.ts`
- Create: `packages/admin-contract/src/courses.ts`（`CourseListItemSchema`）、`index.ts` 导出

**Interfaces:**
- Produces: `GET /admin/courses` → `CourseListItem[]`：`{ slug, title, published: boolean, latestPublishedVersion: number | null, hasDraft: boolean, lessonCount: number, activeEnrollments: number }`，按 `title` 升序。`lessonCount` 取草稿（有草稿时）否则最新已发版版本。

- [ ] **Step 1: 写失败测试** `admin-course-list.service.spec.ts`：有已发版 + 草稿的课程、只有草稿的新课程（`published=false`，`latestPublishedVersion=null`）、`activeEnrollments` 只数 `active` 报名、无任何课程返回 `[]`。再加 controller 级测试：未带令牌 401。
- [ ] **Step 2: 运行确认失败**：`npm test -w api -- admin-course-list`，预期 FAIL（服务未定义）。
- [ ] **Step 3: 实现** `AdminCourseListService.list(): Promise<CourseListItem[]>`：一次 `findMany` 带 `versions`（只选 `version`、`publishedAt`）和 `_count`，课时数与报名数用两次 `groupBy`，避免 N+1。
- [ ] **Step 4: 运行确认通过**，再跑 `npm test -w api` 全量。
- [ ] **Step 5: Commit** `feat: GET /admin/courses lists courses for the admin console`

### Task 2: API —— 素材列表 `GET /admin/courses/:slug/assets`

**Files:**
- Create: `apps/api/src/admin/assets/course-asset-list.service.ts`、`.spec.ts`
- Modify: `admin-courses.controller.ts`（`AdminCoursesController` 增加 `@Get('assets')`）、`admin.module.ts`
- Modify: `packages/admin-contract/src/courses.ts`（`CourseAssetSchema`）

**Interfaces:**
- Consumes: `CourseAssetStorageService` 里由 `objectKey` 得到公开地址的方法（沿用学员读课 `loadCourseAssets` 的口径）。
- Produces: `GET /admin/courses/:slug/assets` → `{ id, url, altText: string | null, mimeType: string | null, createdAt }[]`，按 `createdAt` 倒序；课程不存在 404。

- [ ] **Step 1: 写失败测试**：只返回该课程的素材（另一门课程的素材不出现）、`url` 与学员读课同口径、倒序、课程不存在 404。
- [ ] **Step 2–4:** 运行失败 → 实现 → 运行通过 + 全量。
- [ ] **Step 5: Commit** `feat: GET /admin/courses/:slug/assets lists course assets`

### Task 3: 课程列表页、新建课程、课程页（元信息、模块 / 课时树、发版）

**Files:**
- Create: `apps/admin/lib/courses-api.ts`（`listCourses()`、`getDraft(slug)`、`listAssets(slug)`）
- Create: `apps/admin/app/(app)/courses/page.tsx`、`new-course-form.tsx`、`actions.ts`（`createCourseAction`）
- Create: `apps/admin/app/(app)/courses/[slug]/page.tsx`、`actions.ts`（创建 / 丢弃草稿、改元信息、模块与课时的增改删与排序、发版）
- Create: `apps/admin/components/courses/{course-meta-form,module-tree,publish-dialog}.tsx`
- Modify: `apps/admin/app/(app)/page.tsx`（首页跳到 `/courses`）、`apps/admin/app/(app)/layout.tsx`（顶栏加「课程」导航）

**Interfaces:**
- Consumes: Task 1、2 的接口；已有的 `POST /admin/courses`、`POST|GET|DELETE|PATCH /draft`、`/draft/modules*`、`PUT /draft/order`、`POST /publish`。
- Produces: Server Action 的统一返回 `ActionResult<T> = { status: "ok"; data: T } | { status: "error"; message: string; problems?: Problem[] } | { status: "unauthorized" }`，供编辑器和各表单共用（放 `apps/admin/lib/action-result.ts`）。

- [ ] **Step 1: 写失败测试**（vitest + Testing Library）：
  - 课程列表渲染状态徽章（已发版 / 仅草稿 / 有草稿）与在学人数；空列表显示引导。
  - `new-course-form`：slug 不合法（大写、少于 3 位）在提交前提示；重复 slug（409）显示后端文案；成功后跳转 `/courses/<slug>`。
  - `publish-dialog`：422 时完整列出全部 `problems`（造 40 条），每条带课时标识并链接到编辑器；成功时显示「N 名在学学员会立刻看到新版」。
  - `module-tree`：上移 / 下移后提交的顺序与 `PUT /draft/order` 请求体一致。
- [ ] **Step 2: 运行确认失败**：`npm test -w admin`。
- [ ] **Step 3: 实现。** 页面一律 Server Component 取数，表单和对话框是客户端组件、通过 Server Action 提交；`createCourseAction` 等把 Nest 的 4xx 文案原样放进 `ActionResult`。
- [ ] **Step 4: 运行通过 + 全量**。
- [ ] **Step 5: Commit** `feat: admin course list, course page and publish dialog`

### Task 4: 编辑器状态核心（纯函数，无 React）

**Files:**
- Create: `apps/admin/components/editor/editor-state.ts`、`editor-state.test.ts`
- Create: `apps/admin/components/editor/autosave.ts`、`autosave.test.ts`

**Interfaces:**
- Produces（`editor-state.ts`）：
  - `type EditorState = { blocks: LessonBlock[]; selectedId: string | null; past: LessonBlock[][]; future: LessonBlock[][] }`
  - `type EditorAction = add(type, afterId?) | duplicate(id) | remove(id) | move(id, "up" | "down") | updateProps(id, props) | select(id | null) | undo | redo`
  - `reduce(state, action, ids: () => string): EditorState`；块 id 由注入的 `ids` 产生，便于测试。`add` 的初始属性取 `BLOCK_REGISTRY[type].defaultProps()`；达到 300 块时 `add` / `duplicate` 不生效。`past` 最多 50 步。
- Produces（`autosave.ts`）：纯状态机 `step(state: SaveState, event: SaveEvent): { state: SaveState; effect?: "save" | "schedule" }`，状态 `idle | dirty | saving | saved | failed`，事件 `edit | timerFired | saveOk | saveFailed(unauthorized?) | retry`；`saving` 期间的 `edit` 记为 `dirtyWhileSaving`，保存成功后立即再存一次。

- [ ] **Step 1: 写失败测试**（每条一个用例）：
  - 增删复制排序：复制的块得到新 id 且紧跟原块；`move` 在首 / 尾无效果；`remove` 当前选中块后 `selectedId` 置空。
  - 撤销重做：50 步上限（第 51 步丢弃最旧）；撤销后再编辑会清空 `future`；`select` 不进历史。
  - 300 块上限：`add`、`duplicate` 在上限处原样返回。
  - 自动保存：`edit → dirty →(timer) saving → saveOk → saved`；`saving` 中 `edit` → 成功后再触发一次 `save`，且最终状态是 `saved`（Review Focus 第 1 条）；`saveFailed` → `failed` 且保留 `dirty` 标记，`retry` 回到 `saving`；`unauthorized` 失败不丢本地改动。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**两个纯模块；`ids` 默认实现用 `crypto.randomUUID()` 截取前 12 位并加 `b-` 前缀。
- [ ] **Step 4: 运行通过 + 全量**。
- [ ] **Step 5: Commit** `feat: pure editor state and autosave state machine for the block editor`

### Task 5: 块卡片列表与「添加内容」选择器

**Files:**
- Create: `apps/admin/components/editor/{block-card,block-list,add-block-menu}.tsx` 及测试
- Create: `apps/admin/components/ui/{select,textarea,dialog,badge}.tsx`（shadcn，按需）

**Interfaces:**
- Consumes: Task 4 的 `EditorState` / `EditorAction`；`BLOCK_TYPES`、`BLOCK_REGISTRY[type].label`。
- Produces: `<BlockList blocks problems selectedId dispatch />`；`problems: Record<blockId, Problem[]>`（由保存响应的 `problems.errors / warnings` 按 `blockId` 归并，放 `components/editor/problems.ts`，带测试）。

- [ ] **Step 1: 写失败测试**：卡片显示块类型中文名与一行摘要；点击选中；「编辑 / 复制 / 删除 / 上移 / 下移」按钮触发对应 action（删除前确认）；有错误的卡片显示红色标记和错误文案，仅警告显示黄色；块数达到 300 时「添加内容」禁用并提示上限；刚添加的图片块（默认 `assetId` 为空）带着后端返回的错误正常渲染、不崩溃；`problems.ts` 把 `{ blockId, level, message }` 正确归并，缺 `blockId` 的问题归为课时级。
- [ ] **Step 2–4:** 运行失败 → 实现 → 运行通过 + 全量。
- [ ] **Step 5: Commit** `feat: block cards and add-content menu for the lesson editor`

### Task 6: 属性面板（由 schema 生成表单）+ 素材上传 / 选择

**Files:**
- Create: `apps/admin/components/editor/block-form.tsx`、`form-fields.tsx`（字符串、枚举、数字、字符串数组、对象数组、可选字段）、测试
- Create: `apps/admin/components/editor/asset-picker.tsx`、测试
- Create: `apps/admin/app/(app)/courses/[slug]/assets-actions.ts`（`uploadAssetAction(formData)`）
- Modify: `apps/admin/lib/api-client.ts`（`apiFetchNoRedirect`）、`apps/admin/next.config.ts`（Server Action 请求体上限 6 MB）

**Interfaces:**
- Produces: `<BlockForm block assets onChange />`：用 `z.toJSONSchema(BLOCK_REGISTRY[type].schema)` 递归生成字段；`image` 的 `assetId` 不渲染文本框，渲染 `<AssetPicker />`；`uploadAssetAction(formData): ActionResult<{ id; url; altText; mimeType }>`。

- [ ] **Step 1: 写失败测试**：
  - 对 13 种块各生成一次表单（参数化），每个必填字段都有可访问的标签；编辑后 `onChange` 收到符合该 schema 形状的 props。
  - `callout.variant` 渲染为下拉且只有 `tip|warning|note`；`table` 增删列 / 行后单元格数保持一致（行列数不一致是发版错误，表单要从源头避免）。
  - `AssetPicker`：列出本课程素材并可选中；选中后回写 `assetId`；上传前客户端拦截 >5 MB 与非图片类型并显示文案；上传成功后新素材出现在列表并被选中；后端 4xx 文案原样显示。
  - `uploadAssetAction`：401 返回 `unauthorized` 而不是抛出跳转。
- [ ] **Step 2–4:** 运行失败 → 实现 → 运行通过 + 全量。
- [ ] **Step 5: Commit** `feat: schema-driven block property form and asset upload picker`

### Task 7: 预览 iframe 通道

**Files:**
- Create: `apps/admin/components/editor/preview-frame.tsx`、`preview-channel.ts`、测试
- Modify: `apps/admin/.env.example`、README（`NEXT_PUBLIC_CLIENT_ORIGIN`）

**Interfaces:**
- Produces: `createPreviewChannel({ clientOrigin, getTarget: () => Window | null })`：`post(payload)` 在收到 `lesson-preview-ready`（`event.origin === clientOrigin` 且 `event.source === 目标窗口`）之前只缓存最新一份；ready 之后立即补发缓存并随后每次直接发；永远 `postMessage(payload, clientOrigin)`，不用 `"*"`。`<PreviewFrame src payload />` 5 秒内没有 ready 显示「预览不可用」。
- Payload 形状：`{ type: "lesson-preview", lesson: { title, moduleTitle, blocks }, assets: Record<assetId, { url, alt? }>, problems: { blockId?, level, message }[] }`。

- [ ] **Step 1: 写失败测试**：ready 前多次 `post` 只在 ready 后补发最后一份；来自其他 origin 或其他窗口的 `lesson-preview-ready` 被忽略；每次发送的 `targetOrigin` 等于配置值；未配置 `NEXT_PUBLIC_CLIENT_ORIGIN` 时不渲染 iframe、显示「未配置预览地址」；超时显示「预览不可用」且不抛错。
- [ ] **Step 2–4:** 运行失败 → 实现 → 运行通过 + 全量。
- [ ] **Step 5: Commit** `feat: origin-pinned preview channel to the client preview page`

### Task 8: 编辑器页面装配、测评题与离开保护

**Files:**
- Create: `apps/admin/app/(app)/courses/[slug]/lessons/[contentId]/page.tsx`（Server Component：取草稿树、课时、素材）、`editor.tsx`（客户端装配）、`actions.ts`（`saveLessonAction`、`updateAssessmentAction`）
- Create: `apps/admin/components/editor/{lesson-tree,assessment-panel,save-indicator}.tsx` 及测试
- Modify: `README.md`（运营后台使用说明 + 已知限制：同课时并发编辑后写覆盖先写）

**Interfaces:**
- Consumes: Task 3–7 的全部产出。`saveLessonAction({ slug, contentId, content }): ActionResult<{ problems: ValidationReport }>`：只发 `{ content: { schemaVersion: 1, blocks } }`，401 返回 `unauthorized`。
- 装配：左栏课时树（点击切换课时，切换前若 `dirty / saving / failed` 先阻止并提示）、中栏块列表 + 属性面板、右栏预览 iframe；下方 / 另一页签是本节测评题（沿用 `PATCH /draft/assessments/:assessmentId`）。

- [ ] **Step 1: 写失败测试**：
  - 保存指示器依次显示「保存中 / 已保存 / 保存失败（重试）」；`unauthorized` 显示「登录已过期，请在新标签页重新登录后重试」，且列表与属性面板内容不变。
  - 保存响应的 `problems` 显示在对应卡片上；撤销后重新触发保存。
  - `failed` / `dirty` 时 `beforeunload` 被拦截，`saved` 时不拦截。
  - 预览 payload 随编辑变化；`problems` 一并发给预览页。
  - 测评题：改题干 / 选项后保存成功提示，失败显示后端文案。
- [ ] **Step 2–4:** 运行失败 → 实现 → 运行通过 + 全量；`npx tsc --noEmit`、`npx eslint --no-fix` 对改动文件无错误。
- [ ] **Step 5: Commit** `feat: lesson editor page with autosave, preview and assessments`

### Task 9: 端到端与上线（含 Owen 关卡）

**Files:**
- Create: `apps/admin/e2e/course-editor.spec.ts`（Playwright，`apps/admin/package.json` 增加 `@playwright/test` 与 `test:e2e` 脚本）
- Modify: `README.md`、`apps/admin/.env.example`

- [ ] **Step 1: 端到端（本地库，显式 `DATABASE_URL`）**：登录 → 新建课程 → 加模块和课时 → 添加段落与图片块（上传素材）→ 看到预览 → 发版 → 审计页（4c）出现这次发版且标为「运营」。**4c 未合并时，最后一步改为直接查审计表。** 记录结果。
- [ ] **Step 2: 手动核对**：预览域名配成 Cloudflare 预览站时，`NEXT_PUBLIC_ADMIN_ORIGIN`（client 构建时）与 `NEXT_PUBLIC_CLIENT_ORIGIN`（admin）互相对得上；client 的构建日志没有 `[preview]` 警告。
- [ ] **Step 3: 停下，等 Owen 确认后再上线**：① admin 与 client 的两个环境变量写入各自的 Vercel / Cloudflare 项目并重新构建；② 用真实课程各做一次编辑 → 预览 → 发版（先在草稿课程上）。
- [ ] **Step 4: 全量验证**：`npm test`、`npm run test:e2e`、`tsc --noEmit`、`nest build`、`next build`。
- [ ] **Step 5: Commit** `docs: admin course editor rollout notes`

---

## 范围外 / 待 Owen 确认

- 在界面里**导入** `course.json` / Markdown：spec 第 12 节待确认；本计划不含。
- 课程删除、下架、改 slug、素材删除：不做。
- 同一课时的并发编辑冲突检测：接口没有版本号，不做，写进 README 已知限制。
- 语法高亮：属于 client 渲染，不在本块。
