# 课时块（Lesson Blocks） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 课时内容从一大段 Markdown 变成有序的"块"（`CourseLesson.content Json`）：server 存储、校验、下发；client 按块类型渲染；运营能在后台从零新建课程、上传图片素材，并在发版时拦截非法块。

**Architecture:** 新增 `packages/lesson-blocks`（纯 zod，无 React）定义 13 种块的 schema、校验、纯文本提取和一份标准课时数据；`apps/api` 在写草稿、发版、读课、摄取、回填五处使用它，并新增"新建课程""素材上传"两个 admin 接口；Markdown→块的转换（remark）只在 CLI 里动态加载。client 仓库自己渲染块（扩展 `CourseLessonContent`，样式全部沿用现有变量），并提供不登录、只收 `postMessage` 的 `/preview/lesson` 页供后台 iframe 嵌入。server 不渲染、不发 npm 包；两边靠同一份标准课时数据对齐。

**Tech Stack:**
- server：NestJS 11、Prisma 6、zod 4、jest（沿用）；新增 `unified` + `remark-parse` + `remark-gfm` + `mdast-util-to-string`（仅转换器用，动态 `import()`）；`@nestjs/platform-express` 自带 multer 处理上传（需补 `@types/multer` 开发依赖）。
- client：vinext + React 19、vitest（现有，仅 `app/**/*.test.ts`，任务 14 扩展）。

**Spec:** `docs/superpowers/specs/2026-10-01-lesson-blocks-design.md`（视觉基准 `mockups/2026-10-01-lesson-blocks-mock.html`）

**这是唯一入口。** 本计划包含 monorepo 迁移（任务 0）；它还要用 `docs/superpowers/plans/2026-09-30-course-content-model.md`（下称"B1 计划"，已按块化修订，见它开头的"修订"一节）里的任务 1–11 作为地基（admin 守卫、迁移 A、草稿/发版服务、控制器）。执行者读这两份文档，**顺序只看下面"执行顺序"一节**，不要自己另排。任务编号：`L<n>` = 本计划任务 n，`B1-<n>` = B1 计划任务 n。

工作分支：server 侧 `feat/lesson-blocks`，client 侧 `feat/lesson-blocks-renderer`（执行时用 `superpowers:using-git-worktrees` 各建一个）。提交信息 `<type>: <description>`，署名行按当前会话的提交署名设置。

## 执行顺序

server 与 client 是两个仓库（都是 git 仓库）：server 侧一个执行者按下表从上到下做；client 侧（L14–L19）另一个执行者在 **L4 完成后**开始，与 server 侧并行，两边互不改对方仓库。`docs/` 下的计划和 spec 只由计划作者改。

| # | 任务 | 说明 |
|---|---|---|
| 1 | L0 monorepo 迁移 | 纯搬家，行为零变化。**Vercel 关卡**（Owen）：关卡通过前，该分支不得合并到 `main` |
| 2 | L1 → L2 → L3 → L4 | `packages/lesson-blocks`；L4 产出 `canonical-lesson.json`，**client 侧从这里开始** |
| 3 | L5 → L6 | 转换器，纯函数，不碰库 |
| 4 | B1-1 | admin 令牌守卫 |
| 5 | B1-2 | schema + 迁移 A（加 `content`），只写文件不执行；**Owen 对比页关卡只拦"落库"，不拦后面的 mock 单测任务** |
| 6 | B1-3 → L7 | 切片 + 摄取（先 `body` 后 `content`） |
| 7 | B1-4 → L8 | 学员只读已发版 + 读课带 `blocks`/`assets` |
| 8 | B1-5、B1-6 | 进度按 `contentId`；聊天诊断 |
| 9 | B1-7 → L9 | 回填（先 `body`/进度，后 `content`） |
| 10 | B1-8 | 草稿创建/丢弃/元信息/欢迎页 |
| 11 | B1-9 → L10 | 草稿模块/课时（后者改成 `content` + 块校验） |
| 12 | B1-10 → L11 | 发版（后者换成块校验 + 首次发版规则） |
| 13 | B1-11 → L12 → L13（Step 1–4） | 控制器；新建课程；素材上传 |
| 14 | **关卡：Owen 通过 B1-2 的对比页** | 没通过就停在这里，不碰任何数据库 |
| 15 | B1-12 → L13 Step 5 | 迁移 A 落库 + 回填 dry-run + e2e（B1 与块两份 e2e 一起跑） |
| 16 | 全量验证 + 合并 | `npm test`、`npm run test:e2e`、`npm run test:cov`（≥ 80%）、`npm run build`、`npm run lint` 全绿；**client 渲染器（L18）与预览页（L19）已先上线**，再让 server 回填（spec 第 10 节） |
| — | B1-13（迁移 B） | **本计划不执行**：观察期后，Owen 明说才做 |

上线顺序（spec 第 10 节）在**发布**层面：client 先上线 → server 合并并回填 → 观察期 → 开放后台编辑（第 4 块）→ 迁移 B。

## Global Constraints

- 存储：`CourseLesson.content Json?`，结构 `{ "schemaVersion": 1, "blocks": [{ "id", "type", "props" }] }`；`schemaVersion` 恒为 1；块 `id` 1–64 字符、课时内唯一；一节课最多 300 个块，`content` 序列化后 ≤ 256 KB。`body`（Markdown）在迁移 A 保留作回退，迁移 B 删除；草稿编辑只写 `content`。
- 13 种块与属性上限完全按 spec 第 4 节（`heading`、`paragraph`、`bulletList`、`numberedList`、`code`、`step`、`callout`、`table`、`image`、`resourceLink`、`divider`、`annotatedCode`、`diagram`）；`diagram` 只做纵向流程。
- 行内 Markdown 子集：`**粗体**`、`*斜体*`、`==高亮==`（渲染为加粗，无背景）、`` `行内代码` ``、`[文字](url)`、换行；链接只放行 http / https / mailto，其余当普通文字；不支持原始 HTML，所有文字一律转义。**本计划补充：** 反斜杠转义（`\*` `\` `` \` `` `\[` `\]` `\=` 取字面字符），转换器靠它保证"源文本里的字面 `*` 不会变粗体"（已同步写回 spec 第 4 节）。
- 校验错误（拦截发版）与警告（不拦截）的清单按 spec 第 6 节；写草稿时有错误也保存并返回问题列表，发版 422 一次列全且无部分写入。
- 素材上传：仅 `image/png`、`image/jpeg`、`image/webp`、`image/gif`；≤ 5 MB；按文件头判断类型，不信客户端 `Content-Type`；不收 SVG；不提供删除。
- 新课程 slug：小写字母、数字、连字符，3–60 字符，全局唯一（重复 409），创建后不可改。
- client：只引用现有 CSS 变量（`--ink`、`--surface-*`、`--outline`、`--primary`、`--primary-pale`、`--amber`、`--peach`），不引入新颜色体系，深色主题自动生效；版面按**容器宽度**响应（CSS 容器查询）：≤ 480px 沿用侧栏紧凑样式，批注代码 ≥ 640px 才左右分栏；`prefers-reduced-motion` 要尊重；文字一律转义。
- 预览页只接受 `NEXT_PUBLIC_ADMIN_ORIGIN` 来源的 `postMessage`；不带 Cookie、不写 localStorage、不读 token、不拉任何数据。
- 数据库迁移执行前须经 Owen 对比页确认（B1 计划已定）；在执行顺序第 14 步之前不对任何库执行 `prisma migrate`。
- monorepo 迁移（L0）只搬文件和改配置，**不改任何业务代码和测试**；迁移前后 `npm test` 的用例数和结果必须一致。线上 Vercel 项目的 Root Directory 不在本计划里擅自修改（见 L0 的关卡）。
- 先写测试（RED）再实现；覆盖率不低于 80%。匹配现有风格：server 中文注释/报错、单引号、2 空格缩进；client 沿用其文件风格（双引号）。每行改动可追溯到 spec。

## Review Focus

spec 没明说、但最可能咬到运营或学员的情形，按可能性排序；测试在括号里的任务里。

1. 预览页收到非白名单 origin 的消息，或白名单 origin 发来畸形数据（`blocks` 不是数组、`assets` 缺失、块 `props` 为 `null`）：忽略 / 当作空课时，不崩溃、不泄露（任务 16、18）。
2. 转换结果自己违反 schema 上限（围栏代码 > 20000 字符、段落 > 5000 字符）：进转换报告为 error，回填不写 `content`（保持 `null`，client 走 `markdown` 回退），而不是写进一份发版时才被拦的非法数据（任务 6、9）。
3. 伪造上传：HTML / SVG 改名 `.png`、`Content-Type` 谎报为 `image/png`、0 字节文件、恰好 5 MB 与 5 MB + 1 字节：文件头不对一律 400，边界值按"≤ 5 MB 通过"（任务 13）。
4. 图片块引用**别的课程**的素材 id：发版被拒，读课响应的 `assets` 也不返回别课素材（任务 8、11）。
5. 新课程只有一份草稿、从未发版时 `DELETE /draft`：返回 409，不能留下"零版本课程"（任务 12）。

---

## Part 0 — monorepo 迁移

### Task 0: 把 `aivirteach-server` 改成 npm workspaces（`apps/api` + `packages/*`）

现状（已核对）：仓库根即 Nest 应用（`src/`、`prisma/`、`test/`、`nest-cli.json`、`tsconfig*.json`、`eslint.config.mjs`、`package.json` 里内嵌 jest 配置，`rootDir: src`）；`docker-compose.yml`、`docs/`、`README.md`、`LICENSE`、`NOTICE`、`.gitignore`、`.prettierrc` 也在根；`.vercel/project.json` 把根目录链接到 Vercel 项目 `aivirteach-server`（zero-config Nest，无 `vercel.json`）；`.env`、`.env.local` 被 git 忽略。`mockups/` 在仓库外（上一级目录），不受影响。

**目标布局：**

```
aivirteach-server/
  package.json            # 根：private、workspaces: ["packages/*","apps/*"]（packages 在前，保证先构建）、转发脚本
  package-lock.json       # 在根重新生成
  docker-compose.yml  docs/  README.md  LICENSE  NOTICE  .gitignore  .prettierrc  .vercel/   # 留在根
  apps/api/               # 原仓库的 Nest 应用整体搬入，package 名改为 "api"
    package.json  nest-cli.json  tsconfig.json  tsconfig.build.json  eslint.config.mjs  .env.example
    src/  prisma/  test/
  packages/lesson-blocks/ # L1 创建
```

`apps/admin`、`packages/admin-contract` **不在本任务里建**（第 4 块的计划再建，避免范围膨胀）。

**Files:**
- Move（`git mv`，保留历史）：`src`、`prisma`、`test`、`nest-cli.json`、`tsconfig.json`、`tsconfig.build.json`、`eslint.config.mjs`、`package.json`、`.env.example` → `apps/api/`
- Create: 根 `package.json`；`.gitignore` 补 `packages/*/dist/`（原有的 `dist/`、`coverage/`、`node_modules/` 本就匹配任意层级，不动）
- Modify: `apps/api/package.json`（`name` 改为 `"api"`；`prebuild`/`pretest`/`pretest:cov`/`pretest:e2e`/`precli` 先构建 `packages/lesson-blocks`——脚本在 L1 创建包之后才有意义，本任务先只留 `build` 钩子位置并在 L1 补上）、`README.md`（目录结构与命令）

**Interfaces:**
- Produces：
  - 根脚本：`build`、`test`、`test:cov`、`test:e2e`、`lint` 均转发到各 workspace（`npm run <x> --workspaces --if-present`）；`db:up` 留在根（`docker compose up -d`）；`db:migrate`、`db:reset`、`cli` 留在 `apps/api`，从根用 `npm run cli -w api -- <args>` 调用。
  - **workspace 包名约定：** `apps/api` 的包名是 `api`，所以本计划里的 `-w api` 即指它；`packages/lesson-blocks` 的包名是 `@aivirteach/lesson-blocks`。
  - 从 `apps/api` 目录下执行 `npm test`、`npx tsc --noEmit`、`npm run build`、`npm run cli`、`prisma …` 的行为与迁移前在仓库根执行完全一致（相对路径 `src`、`prisma/schema.prisma`、`.env` 的解析基准都是 `apps/api`）。
- 本机 `.env`、`.env.local`（被忽略）手动 `mv` 到 `apps/api/`，否则 `prisma`/`dotenv` 读不到。

- [ ] **Step 1: 记基线**（迁移前，仓库根）：`npm test`、`npx tsc --noEmit`、`npm run build`、`npm run lint -- --no-fix`（或等价的不改文件模式）。把 `npm test` 的"Test Suites / Tests"总数、tsc 与 build 是否通过记下来；`git status` 干净。
- [ ] **Step 2: 搬文件**：建 `apps/api`，按上面的 Move 清单 `git mv`；`.env`/`.env.local` 用 `mv`；写根 `package.json`（`"private": true`，`"workspaces": ["packages/*", "apps/*"]`，转发脚本）；`apps/api/package.json` 改名；删旧 `node_modules` 与根 `package-lock.json` 后在根执行 `npm install`（会触发 `apps/api` 的 `postinstall: prisma generate`，它不碰数据库）。
- [ ] **Step 3: 验证行为零变化**：在 `apps/api` 下重跑 Step 1 的四条命令，**用例总数和结果必须与基线完全相同**，tsc、build、lint 通过；`npm run cli -w api -- --help` 能列出现有命令；`git diff --stat -M` 里 `src/`、`test/` 下的文件只能是 rename、没有内容改动。任何 import 路径需要改的地方都说明搬迁漏了东西，回头修配置，不改业务代码。
- [ ] **Step 4: 更新 README**：目录结构、启动与测试命令、`.env` 位置（`apps/api/.env`）、Vercel 的 Root Directory 说明（`apps/api`，并开启"Include source files outside of the Root Directory in the Build Step"，因为 `packages/*` 在根目录之外）。
- [ ] **Step 5: 提交**：`git add -A && git commit -m "refactor: move the api into an npm workspaces monorepo"`（commit 前 `git status` 确认没有 `.env*`、`dist`、`coverage` 入库）。
- [ ] **Step 6: 关卡——Vercel（停下来，等 Owen）。** 现在线上项目的 Root Directory 是仓库根；这个分支一旦合并到 `main`，旧设置下构建会失败（失败的构建**不会**替换正在服务的上一版部署，线上不会立刻挂，但会卡住所有后续发布）。给 Owen 的验证方案：新建一个临时 Vercel 项目（Root Directory `apps/api`、开启上面那个选项、从这个分支部署预览，环境变量由 Owen 自己从现有项目复制，**不要把任何密钥写进仓库或贴进对话**），确认预览部署构建成功、`GET /api/v1/health` 返回 200、`/docs` 可打开。Owen 确认后，由 Owen（或经 Owen 明确授权）在现有项目里把 Root Directory 改为 `apps/api` 并开启该选项，**紧接着**合并分支、触发部署。**关卡未通过前，不要修改线上项目的任何设置，也不要把该分支合并到 `main`。** 其余任务（L1 起）不受这个关卡阻塞，都在这个分支上继续。

---

## Part A — server（`aivirteach-server`，monorepo 迁移后路径）

### Task 1: `packages/lesson-blocks` 脚手架 + 行内文本 + 信封 + 8 种简单块

**Files:**
- Create: `packages/lesson-blocks/package.json`、`tsconfig.json`、`jest.config.*`（抄 `apps/api` 的 jest 配置，`rootDir: src`）
- Create: `packages/lesson-blocks/src/index.ts`、`src/blocks/simple.ts`、`src/blocks/simple.spec.ts`、`src/envelope.ts`、`src/envelope.spec.ts`
- Modify: 根 `package.json` workspaces 已含 `packages/*`；`apps/api/package.json` 加依赖 `"@aivirteach/lesson-blocks": "*"`

**Interfaces:**
- Produces（均自 `src/index.ts` 导出）：
  - `const BLOCK_TYPES: readonly ['heading','paragraph','bulletList','numberedList','code','step','callout','table','image','resourceLink','divider','annotatedCode','diagram']`；`type BlockType`。
  - `type LessonBlock = { id: string; type: string; props: unknown }`；`type LessonContent = { schemaVersion: 1; blocks: LessonBlock[] }`。
  - `const LessonEnvelopeSchema`（只校验信封与块外壳：`schemaVersion === 1`、`blocks` 为数组、每块 `id` 1–64 字符字符串、`type` 字符串、`props` 为对象；**不校验 `props` 内容、也不拒绝未知 `type`**，让校验能逐块报错）。
  - 8 个 props schema：`HeadingPropsSchema`（`level` 2|3、`text` **0–200**——空文本是警告不是错误，见任务 3）、`ParagraphPropsSchema`、`ListPropsSchema`（`bulletList`/`numberedList` 共用）、`CodePropsSchema`（`kind: terminal|file|plain`；`kind==='file'` 时 `label` 必填，用 `superRefine`）、`StepPropsSchema`、`CalloutPropsSchema`、`DividerPropsSchema`（`z.object({}).strict()`）。数值与长度全部取自 spec 第 4 节。
- 工作区接线要求（补上 L0 留的钩子位置）：`apps/api/package.json` 的 `prebuild`、`pretest`、`pretest:cov`、`pretest:e2e`、`precli` 都先执行 `npm run build -w @aivirteach/lesson-blocks`；`apps/api` 能 `import { BLOCK_TYPES } from '@aivirteach/lesson-blocks'` 并在 jest 里跑通（包输出格式跟随 `apps/api` 的模块系统：先看 `apps/api/package.json` 的 `type` 和 `tsconfig` 的 `module`；包产出 `dist` 并在 `package.json` 里写 `main`/`types`/`exports`，`npm test` 前的 `prebuild`/`pretest` 先构建包）。

- [ ] **Step 1: 写失败的测试**
  - `envelope.spec.ts`：合法信封通过；`schemaVersion: 2`、`blocks` 非数组、块缺 `id`、`id` 为空串或 65 字符、`props` 为 `null` 各被拒；未知 `type: 'quiz-widget'` **通过**信封校验。
  - `simple.spec.ts`（每种块：合法、边界、非法）：`heading.level` 1 或 4 被拒、`text` 200 字符通过 201 被拒、空串通过；`paragraph.text` 空串被拒、5001 字符被拒；`bulletList.items` 0 项被拒、51 项被拒、单项 501 字符被拒；`code`：`kind:'file'` 无 `label` 被拒、`kind:'terminal'` 无 `label` 通过、`code` 20001 字符被拒、`language` 31 字符被拒；`step.number` 0 与 100 被拒、`title` 空被拒；`callout.variant:'danger'` 被拒、`body` 空被拒；`divider` 带多余属性被拒。
  - 接线：`apps/api` 里一条 `lesson-blocks.wiring.spec.ts` 断言 `BLOCK_TYPES.length === 13`。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w @aivirteach/lesson-blocks`，预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现**：脚手架 + 上面的 schema；`index.ts` 只做导出。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2；`npm run build -w @aivirteach/lesson-blocks && npm test -w api -- lesson-blocks.wiring`（`api` 是 L0 约定的 `apps/api` 包名），预期 PASS。
- [ ] **Step 5: 提交**：`git add packages apps/api/package.json package-lock.json apps/api/src/**/lesson-blocks.wiring.spec.ts && git commit -m "feat: add lesson-blocks package with envelope and simple block schemas"`

---

### Task 2: 5 种复杂块 + 块注册表

**Files:**
- Create: `packages/lesson-blocks/src/blocks/complex.ts`、`complex.spec.ts`、`src/registry.ts`、`registry.spec.ts`
- Modify: `packages/lesson-blocks/src/index.ts`

**Interfaces:**
- Consumes: 任务 1 的 8 个 props schema 与 `BLOCK_TYPES`。
- Produces：
  - `TablePropsSchema`（`columns` 1–8 个字符串（≤ 300 字符）、`rows` ≤ 50 行、每行单元格数 === `columns.length`，`superRefine`）、`ImagePropsSchema`（`assetId` 非空；`alt` 1–300；`caption?` ≤ 300）、`ResourceLinkPropsSchema`（`url` 只放行 `http:`/`https:`/`mailto:`，用 `new URL` 解析判 `protocol`，解析失败即非法；`title` 1–120；`description?` ≤ 300）、`AnnotatedCodePropsSchema`、`DiagramPropsSchema`（`nodes` 2–12 个、节点 `id` 互不相同、每条 `connections` 的 `from`/`to` 必须存在，`superRefine`）。长度取自 spec 第 4 节。
  - `const BLOCK_REGISTRY: Record<BlockType, { label: string; schema: z.ZodType; defaultProps: () => unknown }>`：`label` 是后台"Add Content"里显示的中文名；`defaultProps()` 返回一个**能通过该块 schema 的最小合法属性**（`image` 例外：`assetId`/`alt` 必须由运营填，`defaultProps` 返回空串，测试里明确标注它不通过校验）。

- [ ] **Step 1: 写失败的测试**
  - `complex.spec.ts`：`table`：9 列被拒、51 行被拒、某行 2 格而列数 3 被拒、合法 2×2 通过；`image`：`alt: ''` 被拒、缺 `assetId` 被拒、`caption` 301 字符被拒；`resourceLink`：`javascript:alert(1)`、`data:text/html,x`、`ftp://x`、`not a url` 全部被拒，`https://a.com`、`mailto:a@b.c` 通过；`annotatedCode`：`steps` 0 项与 21 项被拒、某步 `code` 空被拒、`terms` 11 项被拒；`diagram`：1 个节点被拒、13 个被拒、`connections` 指向不存在节点被拒、节点 id 重复被拒、合法 3 节点通过。
  - `registry.spec.ts`：`Object.keys(BLOCK_REGISTRY)` 与 `BLOCK_TYPES` 相同（顺序也相同）；除 `image` 外每个 `defaultProps()` 通过自己的 schema；`image` 的不通过；**每个 schema 都能 `z.toJSONSchema(schema)` 不抛错**（后台属性表单靠它生成，别等到第 4 块才发现不行）。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w @aivirteach/lesson-blocks -- complex registry`，预期 FAIL。
- [ ] **Step 3: 实现** `complex.ts`、`registry.ts`，`index.ts` 补导出。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2；`z.toJSONSchema` 若对某个 `superRefine` 的 schema 抛错，改用 `z.toJSONSchema(schema, { unrepresentable: 'any' })` 并在测试里写明原因。
- [ ] **Step 5: 提交**：`git commit -m "feat: add complex lesson block schemas and block registry"`

---

### Task 3: 课时内容校验 `validateLessonContent` 与派生函数

**Files:**
- Create: `packages/lesson-blocks/src/validate.ts`、`validate.spec.ts`、`src/derive.ts`、`derive.spec.ts`
- Modify: `packages/lesson-blocks/src/index.ts`

**Interfaces:**
- Consumes: 任务 1–2 的 schema 与 `BLOCK_REGISTRY`。
- Produces：
  - `type Problem = { level: 'error' | 'warning'; code: ProblemCode; message: string; blockId?: string; blockIndex?: number }`；`type ProblemCode = 'invalid-envelope' | 'too-many-blocks' | 'too-large' | 'unknown-type' | 'invalid-props' | 'duplicate-id' | 'unknown-asset' | 'step-gap' | 'heading-skip' | 'empty-heading' | 'no-blocks'`（前 8 个 error，后 4 个 warning）。
  - `type ValidationReport = { errors: Problem[]; warnings: Problem[] }`。
  - `validateLessonContent(input: unknown, ctx: { courseAssetIds: ReadonlySet<string> }): ValidationReport`（纯函数，**不抛异常**，对 `null`/字符串/数组等任意输入返回 `invalid-envelope`）：信封不合法 → 只报 `invalid-envelope`；块数 > 300 → `too-many-blocks`；`JSON.stringify` 后 > 256 KB → `too-large`；逐块：`type` 不在注册表 → `unknown-type`，`props` 不过 schema → `invalid-props`（`message` 带字段路径，如 `props.alt：不能为空`），`id` 重复 → `duplicate-id`（后出现的那块），`image.assetId` 不在 `courseAssetIds` → `unknown-asset`；警告：`step.number` 在已出现的 step 序列里不连续（相对前一个 step 不是 +1，第一个 step 不要求从 1 起）→ `step-gap`，第一个 `heading` 之前或 H2 之前出现 level 3 → `heading-skip`，`heading.text` 去空白为空 → `empty-heading`，`blocks` 为空 → `no-blocks`。
  - `countRenderableBlocks(content: unknown): number`：已知类型且 props 合法的块，减去 `empty-heading`、减去 `items` 全为空白的列表。发版"每节至少一个会渲染的块"用它。
  - `collectImageAssetIds(content: unknown): string[]`：去重，非法输入返回 `[]`。
  - `blocksToPlainText(content: unknown): string`：按块序拼接各块的可见文字（heading、paragraph、列表项、code 的 `code`、step、callout、table 单元格、image 的 `alt`+`caption`、resourceLink、annotatedCode、diagram），行内标记剥掉（`**` `*` `==` 反引号、`[t](u)`→`t`、反斜杠转义还原），换行分隔。回填的纯文本等价检查用。

- [ ] **Step 1: 写失败的测试**
  - `validate.spec.ts`：合法 2 块 → 两个数组都空；`null`、`'x'`、`[]`、`{}` → `errors` 恰好一条 `invalid-envelope` 且不抛；301 块 → `too-many-blocks`；单个 `code` 块塞 20000 字符 × 14 个块（总 > 256 KB 而每块合法）→ `too-large`；未知类型 `quiz-widget` → `unknown-type` 且 `blockId`、`blockIndex` 正确；`image.alt: ''` → `invalid-props` 且 `message` 含 `alt`；两块同 `id` → 只在第二块报 `duplicate-id`；`image.assetId` 不在集合 → `unknown-asset`；一个文档同时含 4 种错误 → 一次全报出（不是遇到第一个就停）；警告：step 编号 1、3 → `step-gap`；只有 H3 → `heading-skip`；`heading.text: '  '` → `empty-heading` 且**不在 errors 里**；`blocks: []` → `no-blocks`；警告不进 `errors`。
  - `derive.spec.ts`：`countRenderableBlocks`：空标题、全空项列表、未知类型、props 非法的块都不计数；`collectImageAssetIds` 去重；`blocksToPlainText` 对 `**a** *b* ==c== \`d\` [e](https://x.y) \*f\*` 得到 `a b c d e *f*`，对 table 含全部单元格，`image` 含 `alt`。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w @aivirteach/lesson-blocks -- validate derive`，预期 FAIL。
- [ ] **Step 3: 实现**：逐块校验用 `BLOCK_REGISTRY[type].schema.safeParse`；`message` 把 zod issue 的 `path` 与中文说明拼成一句话（中文报错，沿用仓库风格）。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: add lesson content validation and derived helpers"`

---

### Task 4: 标准课时数据（canonical fixture）

**Files:**
- Create: `packages/lesson-blocks/fixtures/canonical-lesson.json`、`packages/lesson-blocks/src/canonical.spec.ts`
- Modify: `packages/lesson-blocks/package.json`（`files`/`exports` 暴露 `fixtures/canonical-lesson.json`）

**Interfaces:**
- Produces：`canonical-lesson.json`，结构 `{ "fixtureVersion": 1, "assets": { "<assetId>": { "url": string, "alt"?: string } }, "valid": LessonContent, "invalid": Array<{ "name": string, "content": unknown, "expectedCodes": ProblemCode[] }> }`。`valid` 含**全部 13 种块各至少一个**，并覆盖边界（`code` 三种 `kind`、`callout` 三种 `variant`、行内 Markdown 子集全部写法、`table` 键值表、`annotatedCode` 带 `terms`、`diagram` 3 节点、`image` 引用 `assets` 里的 id）。`invalid` 至少含：未知类型、`image.alt` 为空、`table` 行列数不一致、`diagram` 悬空连接、`resourceLink` 为 `javascript:`、重复块 id、`image` 引用不存在素材、`content` 不是对象。client 的测试（任务 19）读同一份。

- [ ] **Step 1: 写失败的测试**（`canonical.spec.ts`）：`valid` 经 `validateLessonContent(valid, { courseAssetIds: Object.keys(assets) })` 零错误零警告；`valid.blocks` 覆盖 `BLOCK_TYPES` 全部 13 种；`invalid` 每一条的 `errors` 代码集合**包含**其 `expectedCodes`；`fixtureVersion === 1`。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w @aivirteach/lesson-blocks -- canonical`，预期 FAIL（文件不存在）。
- [ ] **Step 3: 手写 fixture**：文字内容参考 `mockups/2026-10-01-lesson-blocks-mock.html` 里的示例课（26 块），其中故意的边界样例（空标题、缺素材、未知类型、编号断档）放进 `invalid` 或单独的 warning 样例，**不要**放进 `valid`。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2；`npm test -w @aivirteach/lesson-blocks` 全量通过，`npm run test:cov -w @aivirteach/lesson-blocks` 覆盖率 ≥ 80%。
- [ ] **Step 5: 提交**：`git commit -m "test: add canonical lesson fixture shared with client"`

---

### Task 5: Markdown→块 转换器（块级映射）

**Files:**
- Create: `apps/api/src/courses/lesson-conversion/markdown-to-blocks.ts`、`markdown-to-blocks.spec.ts`
- Modify: `apps/api/package.json`（加 `unified`、`remark-parse`、`remark-gfm`、`mdast-util-to-string`、`@types/mdast`；先 `npm view` 确认当前 ESM 版本）

**Interfaces:**
- Consumes: 任务 1–3 的类型。
- Produces：
  - `type ConversionIssue = { level: 'warning' | 'error'; code: string; message: string; line?: number }`
  - `type ConversionResult = { content: LessonContent; report: ConversionIssue[]; dropped: string[] }`（`dropped`：被丢弃节点的纯文本，如一级标题，供等价检查扣除）
  - `convertMarkdownToBlocks(markdown: string, ctx: { assetIdsByFilename: ReadonlyMap<string, string> }): Promise<ConversionResult>`：**异步**，函数内 `await import('unified')` 等（ESM 动态加载，API 进程启动时不加载）。块 `id` 按序生成 `b-001`、`b-002`……
- 本任务只做块级映射；行内、图片、引用、HTML、校验见任务 6。

映射（spec 第 8 节）：`##`/`###`→`heading` 2/3，`####` 及更深降为 3；`#` 丢弃、记 `h1-dropped` 警告并写入 `dropped`；`---`→`divider`；围栏代码：`bash`/`sh`/`shell`/`console`/`zsh` → `kind:'terminal'`，其余（含无语言）→ `kind:'plain'`，`language` 取围栏语言名，`label` 不填；表格（GFM）→ `table`；无序/有序列表 → `bulletList`/`numberedList`（嵌套项拍平并记 `nested-list-flattened` 警告）；段落 → `paragraph`（行内先按纯文本取，任务 6 再做格式映射）。

- [ ] **Step 1: 写失败的测试**（用 `__fixtures__/sample-course/lesson-source.md` 加若干内联字符串）：`## A\n### B` → 两个 heading，level 2、3；`#### C` → level 3；`# T` → 无块、`report` 含 `h1-dropped`、`dropped` 含 `T`；```` ```bash ````/```` ```sh ````/```` ```zsh ```` → `terminal`；```` ```python ````、```` ```ts ````、无语言 → `plain` 且 `language` 对应；`label` 在所有 code 块上都是 `undefined`；GFM 表格 → `columns`/`rows` 正确；`---` → `divider`；嵌套列表 → 单层且含警告；块 `id` 为 `b-001…` 且互不相同；**不丢内容**：任何输入下 `blocksToPlainText(result.content)` 去空白后包含每个输入段落的文字。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- markdown-to-blocks`，预期 FAIL。
- [ ] **Step 3: 实现**：`unified().use(remarkParse).use(remarkGfm).parse(md)` 得 mdast，自顶向下遍历根节点的直接子节点；未识别节点类型留给任务 6 的兜底。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2；确认 jest 能加载 ESM 依赖（`npm test` 脚本已带 `--experimental-vm-modules`，动态 `import()` 在 ts-jest 里若报错，在 jest 配置里为这几个包加 `transformIgnorePatterns` 例外，并把结论写进测试文件顶部注释）。
- [ ] **Step 5: 提交**：`git commit -m "feat: convert markdown blocks to lesson blocks"`

---

### Task 6: 转换器——行内、图片、引用、兜底、校验与等价检查

**Files:**
- Create: `apps/api/src/courses/lesson-conversion/inline.ts`、`inline.spec.ts`、`plain-text.ts`、`plain-text.spec.ts`
- Modify: `apps/api/src/courses/lesson-conversion/markdown-to-blocks.ts`、`markdown-to-blocks.spec.ts`

**Interfaces:**
- Consumes: 任务 5 的 `convertMarkdownToBlocks`、`ConversionResult`；任务 3 的 `validateLessonContent`、`blocksToPlainText`。
- Produces：
  - `inlineToMarkdownSubset(nodes: PhrasingContent[], report: ConversionIssue[]): string`：strong→`**`、emphasis→`*`、inlineCode→反引号、link→`[t](u)`（仅 http/https/mailto，其余只保留文字）、break→`\n`；其他行内节点（delete、footnote…）降为纯文本；文字里的 `\` `*` `` ` `` `[` `]` `=` 用反斜杠转义。
  - `markdownToPlainText(markdown: string): Promise<string>`：remark 解析后对整份文档做 `mdast-util-to-string`（图片取 alt、链接取文字、代码取原文、不含 URL）。
  - `checkPlainTextEquivalence(markdown: string, result: ConversionResult): Promise<{ equal: boolean; expected: string; actual: string }>`：两边各去掉全部空白后比较；旧一侧先扣除 `result.dropped` 里的文字。
  - `convertMarkdownToBlocks` 增强：段落/列表/表格单元格/标题用 `inlineToMarkdownSubset`；图片：文件名（路径最后一段）在 `assetIdsByFilename` 里 → `image`（`alt` 取图片 alt，空则取文件名并记 `empty-alt-defaulted` 警告），对不上 → 保留为带警告的 `paragraph`（文字 `[图片缺失：<文件名>]`，`missing-asset` 警告）；引用块 → `callout`（`variant: 'note'`，`body` 为其内文）；原始 HTML 等其他节点 → 纯文本 `paragraph` + `unmapped-node` 警告；**输出必须过校验**：对结果调用 `validateLessonContent(content, { courseAssetIds })`，每个 error 以 `level:'error'` 追加进 `report`（`code: 'invalid-output'`）。

- [ ] **Step 1: 写失败的测试**
  - `inline.spec.ts`：`**a**`、`*a*`、`` `a` ``、`[a](https://x.y)`、硬换行各正确；`[a](javascript:alert(1))` → `a`（无链接语法）；源文字 `2 * 3 = 6` → 输出里 `*`、`=` 被转义，且 `blocksToPlainText` 还原回 `2 * 3 = 6`；`~~x~~` → `x`。
  - `plain-text.spec.ts`：`markdownToPlainText` 对图片取 alt、对链接不含 URL；`checkPlainTextEquivalence` 对 sample-course 全文 `equal: true`；人为改掉结果里一个字 → `equal: false` 且 `actual` 与 `expected` 可见差异；含 `# 标题` 的输入因 `dropped` 扣除仍 `equal: true`。
  - `markdown-to-blocks.spec.ts`（增量）：`![图](./a.png)` 且 `assetIdsByFilename` 有 `a.png` → `image` 块 `assetId` 对；无对应素材 → 占位段落 + `missing-asset`；`> 提示` → `callout`/`note`；`<div>x</div>` → 段落 + `unmapped-node`；**Review-focus 2**：21000 字符的围栏代码 → `report` 含 `level:'error'`、`code:'invalid-output'`（该课将不被回填写入）；5001 字符的段落同理；合法输入的 `report` 里没有 `error`。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- lesson-conversion`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2；`npm run test:cov -w api -- lesson-conversion` 该目录覆盖率 ≥ 80%。
- [ ] **Step 5: 提交**：`git commit -m "feat: map inline markdown, images and fallbacks in lesson conversion"`

---

### Task 7: 摄取时转换并写入 `content`（接入 block 1 任务 3）

**Files:**
- Modify: `apps/api/src/courses/course-ingestion.service.ts`、`course-ingestion.service.spec.ts`
- Modify: `apps/api/src/admin/commands/course.command.ts`（`course:create` 输出转换报告）及其 spec

**Interfaces:**
- Consumes: block 1 任务 3 的 `sliceLessonBody`；任务 6 的 `convertMarkdownToBlocks`；block 1 任务 2 里加了 `content Json?` 的 schema。
- Produces：摄取时每节 `lessons.create` 写 `body`（保持 block 1 的切片，作回退）**和** `content`（转换结果的 `content`）；该节转换报告含 `error` → `content` 写 `null`（回退到 `body`），不让摄取失败。`CourseIngestionService` 的结果里新增 `conversionReports: Array<{ lessonContentId: string; issues: ConversionIssue[] }>`；`course:create` 命令把它连同现有 JSON 一起打印（警告条数 + 每节 error 明细）。`assetIdsByFilename` 由摄取过程已写入的 `CourseAsset`（按 `objectKey` 最后一段文件名）构造。

- [ ] **Step 1: 写失败的测试**：用 sample-course，每节 `content` 的 `blocks` 非空且通过 `validateLessonContent`，`body` 仍等于切片；某节转换含 `error`（mock 转换器返回）→ 该节 `content: null`，其余节正常，摄取不抛；`conversionReports` 每节一条；命令输出含报告；`course:create` 的 dry-run 同样输出报告且不写库。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- course-ingestion course.command`，预期 FAIL。
- [ ] **Step 3: 实现**：转换在 `$transaction` **之前**完成（异步 + 动态 import，不放进事务里占连接）。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: convert lesson markdown to blocks at ingestion"`

---

### Task 8: 读课响应带 `blocks` 与 `assets`（接入 block 1 任务 4）

**Files:**
- Modify: `apps/api/src/courses/lesson-response.ts`、`lesson-response.spec.ts`、`courses.service.ts`、`courses.service.spec.ts`

**Interfaces:**
- Consumes: 任务 3 的 `collectImageAssetIds`；block 1 任务 4 的 `buildLessonResponse`。
- Produces：`LessonResponse` 增加 `blocks: LessonBlock[] | null`（`content` 是合法信封则为其 `blocks`，`content` 为 `null` 或信封非法则 `null`）与 `assets: Record<string, { url: string; alt?: string }>`；`markdown` 仍取 `body`（标记 `@deprecated`，迁移 B 后删）。`buildLessonResponse` 输入增加 `courseAssets: Array<{ id: string; objectKey: string; altText: string | null }>`，**只**把该课时 `image` 块引用且在 `courseAssets` 里的素材放进 `assets`。`CoursesService.getLesson` 与（任务 11 的）草稿预览共用同一个取素材的辅助函数 `loadCourseAssets(prisma, courseId, ids)`（`courseAsset.findMany({ where: { courseId, id: { in: ids } } })`，`ids` 为空时不查库）。

- [ ] **Step 1: 写失败的测试**：`content` 有 3 块（含 2 个 image 引用 A、B）+ `courseAssets` 里有 A、B、C → `assets` 只有 A、B，`url` 等于 `objectKey`，`alt` 取 `altText`；`content: null` → `blocks: null`、`assets: {}`、`markdown` 仍是 `body`；信封非法 → `blocks: null`；**Review-focus 4**：image 引用的 id 不在 `courseAssets`（别课素材）→ `assets` 里没有它，响应不报错；`getLesson` 的 `courseAsset.findMany` 的 `where.courseId` 等于该课程 id；无 image 块时 `findMany` 不被调用。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- lesson-response courses.service`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: return blocks and referenced assets in lesson response"`

---

### Task 9: 回填 `content`（接入 block 1 任务 7）

**Files:**
- Modify: `apps/api/src/admin/backfill/content-model-backfill.service.ts`、`.spec.ts`、`apps/api/src/admin/commands/course-backfill.command.ts`、`.spec.ts`

**Interfaces:**
- Consumes: 任务 6 的 `convertMarkdownToBlocks`、`checkPlainTextEquivalence`；block 1 任务 7 的 `ContentModelBackfillService`、`BackfillReport`。
- Produces：`BackfillReport` 增加 `content: { filled: number; skipped: Array<{ lessonId: string; reason: string }>; reports: Array<{ lessonId: string; issues: ConversionIssue[] }> }`。对 `content IS NULL` 且 `body !== ''` 的课时：转换 → 有 `error` 级问题 → 不写、进 `skipped`（`reason` 含问题摘要）；`checkPlainTextEquivalence` 不等 → 不写、进 `skipped`（`reason: '纯文本与 body 不一致'`）；否则写 `content`。已有 `content` 的课时不动（可重复运行）；`execute: false` 只统计不写。回填检查点（Owen 审阅）由此变为"转换报告 + 纯文本等价"，替换 block 1 里"`body` 与旧 `getLesson` 逐字一致"。

- [ ] **Step 1: 写失败的测试**：转换成功且等价 → `execute:true` 时 `courseLesson.update` 写 `content`；`execute:false` 不写但 `filled` 相同；含 `error` 的（21000 字符代码块，Review-focus 2）→ 不写、`skipped` 有它；人为让等价检查失败 → 不写；已有 `content` 的课时不被覆盖；命令的 JSON 输出含 `content` 小节且 `--execute` 才写。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- backfill`，预期 FAIL。
- [ ] **Step 3: 实现**：`assetIdsByFilename` 按课程取 `CourseAsset` 构造；每节转换后立刻释放，避免一次把所有课时的 mdast 留在内存里。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: backfill lesson content blocks with plain-text equivalence check"`

---

### Task 10: 写草稿时校验块（接入 block 1 任务 9）

**Files:**
- Modify: `apps/api/src/admin/draft/draft.schemas.ts`、`draft-content.service.ts`、`draft-content.service.spec.ts`

**Interfaces:**
- Consumes: 任务 3 的 `validateLessonContent`、`ValidationReport`；block 1 任务 9 的 `DraftContentService`。
- Produces：
  - `CreateLessonInput`、`UpdateLessonPatch` 里的 `body` 字段换成 `content?: unknown`（`.strict()` 不变；`body` 不再接受，传了就 400）。
  - `createLesson`/`updateLesson` 返回类型由 `DraftVersion` 改为 `DraftEditResult = { draft: DraftVersion; problems: ValidationReport }`。保存规则：信封不是对象、或 `JSON.stringify(content)` > 256 KB → `BadRequestException`（不保存，防止存垃圾和超大请求，**这是对 spec"有错也允许保存"的唯一收紧，已写回 spec 第 6 节**）；其余有错误的内容**照常保存**，`problems` 带回全部错误与警告。`courseAssetIds` 由 `courseAsset.findMany({ where: { courseId }, select: { id: true } })` 取得。新课时 `content` 默认 `{ schemaVersion: 1, blocks: [] }`。
  - 其他草稿方法的返回类型不变。

- [ ] **Step 1: 写失败的测试**：更新含未知块 + 空 alt 的 content → `courseLesson.update` 被调用（已保存），`problems.errors` 含 `unknown-type` 与 `invalid-props`；合法 content → `problems` 两数组为空；`content: 'text'`、`content: null`、`[]` → `BadRequestException` 且无写库；> 256 KB → `BadRequestException`；传 `body` → schema 拒绝；新建课时默认空块数组；`image.assetId` 指向本课程素材 → 无 `unknown-asset`，指向别课素材 → 有；Review-focus（草稿半成品）：保存后再 `PATCH` 一次修好 → `problems` 清空。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- draft-content`，预期 FAIL。
- [ ] **Step 3: 实现**，审计 action 与 block 1 保持（`admin.draft.updateLesson` / `createLesson`）。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: validate lesson blocks on draft write and return problems"`

---

### Task 11: 发版校验块 + 首次发版规则（接入 block 1 任务 10）

**Files:**
- Modify: `apps/api/src/admin/draft/publish-validation.ts`、`publish-validation.spec.ts`、`course-publish.service.ts`、`course-publish.service.spec.ts`

**Interfaces:**
- Consumes: 任务 3 的 `validateLessonContent`、`countRenderableBlocks`；block 1 任务 10 的 `validateDraftForPublish`、`CoursePublishService.publish`。
- Produces：`validateDraftForPublish` 入参增加 `isFirstPublish: boolean`；规则变更：
  - **删除**"每节 `body` 非空"，改为：每节 `content` 通过 `validateLessonContent`（有任何 `errors` 即问题，文案前缀 `模块「X」/课时「Y」：`，逐条列出）；每节 `countRenderableBlocks(content) >= 1`（`content` 为 `null` 视为 0）。警告**不**进返回值。
  - `isFirstPublish` 为真时：至少一个模块，且每个模块至少一节课。
  - 其余规则（contentId 版本内唯一、position 连续、封面/概览素材存在、meta 合法）不变。
  - `courseAssetIds` 仍是**本课程**素材集合（跨课程引用因此被拒——Review-focus 4）。
  - `publish` 取"该课程是否已有已发版版本"算出 `isFirstPublish` 传入。

- [ ] **Step 1: 写失败的测试**：合法草稿 → `[]`；3 种问题同时存在（课时 A 有未知块、课时 B 零块、课时 C 的 image 引用别课素材）→ 一次返回 ≥ 3 条且文案含模块/课时名；只有警告（step 断档）→ `[]`；`content: null` 的课时 → 报"没有可渲染的块"；`isFirstPublish` 且零模块 → 含"至少需要一个模块"，某模块无课时 → 含该模块名；非首次发版零模块不触发该规则；`publish` 校验失败 → 422 且 `problems` 完整、`$transaction` 未调用；首次发版成功后 `Course.published: true`。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- publish-validation course-publish`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: validate lesson blocks and first-publish rules at publish"`

---

### Task 12: 新建课程 `POST /admin/courses`（含 `GET /draft`、草稿规则）

**Files:**
- Create: `apps/api/src/admin/draft/course-create.service.ts`、`.spec.ts`
- Modify: `apps/api/src/admin/draft/course-draft.service.ts`、`.spec.ts`、`apps/api/src/admin/admin-courses.controller.ts`、`.spec.ts`、`apps/api/src/admin/admin.module.ts`

**Interfaces:**
- Consumes: block 1 任务 8 的 `CourseDraftService`、`DRAFT_INCLUDE`；任务 11 的发版规则。
- Produces：
  - `CourseCreateService.create(input: { slug: string; title: string }, operator: string): Promise<DraftVersion>`：`CreateCourseSchema`（`.strict()`；`slug` 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` 且 3–60 字符；`title` 1–120）。一个 `$transaction` 内创建 `Course`（`published: false`、`contentId: null`，其余必填字段用占位默认值，标题取 `title`）+ `CourseVersion`（`version: 1`、`publishedAt: null`）+ 空欢迎页；事务内 slug 唯一冲突（`P2002`）→ `ConflictException('slug 已被占用：…')`；事务提交后写审计 `admin.course.create`（`targetType: 'Course'`）。
  - `AdminCoursesController` 新增 `@Controller('admin/courses')` 下的 `POST /`（要 `X-Operator`，201，返回草稿）——与已有 `admin/courses/:slug` 控制器并存（新建一个小控制器类放在同一文件里）；`GET /admin/courses/:slug/draft` → `requireDraft`（block 1 路由表里没有它，spec 第 12 节需要）。
  - `CourseDraftService.createDraft`：已有草稿 → 返回它；无草稿且无已发版 → 404（沿用）；`discardDraft`：该课程**没有任何已发版版本**时 → `ConflictException('未发版课程的草稿不能丢弃')`（Review-focus 5）。

- [ ] **Step 1: 写失败的测试**
  - `course-create.service.spec.ts`：合法输入 → 事务内三次创建（Course `published:false`/`contentId:null`、v1 草稿 `publishedAt` 未设置、欢迎页），审计恰好一条且在事务之后；`slug` 为 `ab`、`A-b`、`a_b`、`-ab`、61 字符、含空格各被拒；`P2002` → 409；事务失败 → 不写审计（"失败不留残留"用事务回滚断言：`create` 只在 `$transaction` 回调里被调用）；新课程 `published` 为 `false`（学员列表过滤由 `published` 决定，加一条断言 `CoursesService.list` 的 `where.published === true`）。
  - 控制器：无令牌 401、缺 `X-Operator` 400、`POST /admin/courses` 201；`GET /admin/courses/:slug/draft` 无草稿 404。
  - `course-draft.service.spec.ts`：只有草稿无已发版时 `discardDraft` → 409 且无写库；有已发版 + 草稿时丢弃正常。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- course-create course-draft admin-courses`，预期 FAIL。
- [ ] **Step 3: 实现**，`AdminModule` 注册 `CourseCreateService`。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: create courses from the admin api with a draft v1"`

---

### Task 13: 素材上传 `POST /admin/courses/:slug/assets` + 块 e2e

**Files:**
- Create: `apps/api/src/admin/assets/image-sniff.ts`、`image-sniff.spec.ts`、`course-asset-upload.service.ts`、`.spec.ts`
- Modify: `apps/api/src/courses/course-asset-storage.service.ts`、`.spec.ts`、`apps/api/src/admin/admin-courses.controller.ts`、`.spec.ts`、`apps/api/src/admin/admin.module.ts`、`apps/api/package.json`（`@types/multer` 开发依赖）
- Create: `apps/api/test/lesson-blocks.e2e-spec.ts`（**仅在 Owen 通过 block 1 任务 2 的对比页并完成任务 12 落库后才执行**）

**Interfaces:**
- Consumes: block 1 的 admin 守卫与 `X-Operator`；现有 `CourseAssetStorageService`。
- Produces：
  - `sniffImageMime(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null`：只看魔数（PNG `89 50 4E 47 0D 0A 1A 0A`；JPEG `FF D8 FF`；GIF `GIF87a`/`GIF89a`；WebP `RIFF` + 偏移 8 处 `WEBP`）；不足长度返回 `null`。
  - `CourseAssetStorageService.uploadBuffer(pathname: string, body: Buffer, contentType: string): Promise<string>`（`put(..., { access: 'public', contentType, addRandomSuffix: true })` 返回 URL）；原 `upload(pathname, filePath)` 改为读文件后委托它（行为不变）。
  - `CourseAssetUploadService.upload(slug: string, file: { buffer: Buffer; size: number }, altText: string | undefined, operator: string): Promise<{ id: string; url: string; altText: string | null; mimeType: string }>`：课程不存在 → 404；`size` 为 0 或 > 5 × 1024 × 1024 → 400；`sniffImageMime` 为 `null` → 400（文案不回显客户端 `Content-Type`）；`altText` ≤ 300；存储路径 `courses/<courseId>/<uuid>.<ext>`；写 `CourseAsset`（`type: 'image'`、`objectKey` = URL、`mimeType` = 嗅探结果）；写审计 `admin.course.uploadAsset`（`metadata: { slug, assetId, mimeType, size }`）。存储失败 → 抛出且**不**写 `CourseAsset`。
  - 控制器：`POST /admin/courses/:slug/assets`，`FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } })`（multer 超限报 413，控制器里统一映射为 400 并给中文文案）；缺 `file` 字段 → 400；要 `X-Operator`；无删除路由。

- [ ] **Step 1: 写失败的测试**
  - `image-sniff.spec.ts`：四种真实魔数各识别；`<svg …>`、`<html>`、`%PDF`、空 buffer、3 字节 buffer → `null`；PNG 头改名 `.jpg` 仍判 PNG（只看内容）。
  - `course-asset-upload.service.spec.ts`：合法 PNG → 存储被调、`courseAsset.create` 的 `mimeType` 为 `image/png`、返回 `id`/`url`；**Review-focus 3**：内容是 SVG/HTML 且调用方声称 `image/png` → 400、存储与数据库均未被调；0 字节 → 400；恰好 5 MB → 通过，5 MB + 1 字节 → 400；存储抛错 → 不写 `courseAsset`、不写审计；成功才写一条审计；路径含 `courseId` 且不含用户提供的文件名。
  - 控制器：无令牌 401；缺 `file` 400；超限 400；正常 201。
  - `course-asset-storage.service.spec.ts`：`uploadBuffer` 带 `contentType`；`upload(path, file)` 行为与原来一致。
- [ ] **Step 2: 跑测试确认失败**：`npm test -w api -- image-sniff course-asset-upload admin-courses course-asset-storage`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 写 e2e 并验证**（落库后）：真库——新建课程→加模块课时→写含 image 块的 content（素材来自上传，存储用桩）→发版成功→学员读课 `blocks`/`assets` 正确；未发版前学员课程列表看不到；跨课程素材发版被拒；非法块发版 422 且数据库无变化。随后 `npm test`、`npm run test:e2e`、`npm run test:cov`（≥ 80%）、`npm run build`、`npm run lint` 全部通过。
- [ ] **Step 6: 提交**：`git add apps/api && git commit -m "feat: upload course image assets with magic-byte validation"`

---

## Part B — client（`aivirteach-client` 仓库，可与任务 5–13 并行）

client 现状：vinext + React 19，样式在 `app/globals.css`（`.lesson-markdown`、`.lesson-code-block`、`.sidebar-lesson*`、`.lesson-activity`、颜色变量和 `html[data-theme="dark"]`），`CourseLessonContent` 只在 `app/workspace/page.tsx`（约 509 行 `<CourseLessonContent markdown={lesson.markdown} />`）用；vitest 配置独立（`vitest.config.ts`，只跑 `app/**/*.test.ts`，纯函数单测，没有 DOM 环境）；已有 `isSafeMarkdownHref`（`app/workspace/markdown-safety.ts`）。**React 渲染测试用 `react-dom/server` 的 `renderToStaticMarkup`，不引入 jsdom / testing-library。**

### Task 14: 测试基础设施 + 块的 TS 类型 + 标准课时数据拷贝

**Files:**
- Modify: `vitest.config.ts`
- Create: `app/lib/lesson-blocks/types.ts`、`app/lib/lesson-blocks/__fixtures__/canonical-lesson.json`（拷自 server 的 `packages/lesson-blocks/fixtures/canonical-lesson.json`，文件首个 key 之后无法写注释，故在 `types.ts` 顶部注释写明来源与"改块定义时两边都要更新"）、`app/lib/lesson-blocks/render-smoke.test.tsx`

**Interfaces:**
- Produces：`vitest.config.ts` 的 `include` 增加 `app/**/*.test.tsx`，并加 `esbuild: { jsx: "automatic" }`（因为本配置不继承 Next 的 tsconfig `jsx: preserve`）；`types.ts` 导出与 spec 第 4 节一一对应的联合类型：`LessonBlock = HeadingBlock | ParagraphBlock | … | DiagramBlock`（`type` 判别、`props` 具体类型）、`RawLessonBlock = { id: string; type: string; props: unknown }`、`LessonAssets = Record<string, { url: string; alt?: string }>`。

- [ ] **Step 1: 写失败的测试**：`render-smoke.test.tsx` 里渲染一个最小 React 元素 `renderToStaticMarkup(<div>ok</div>)` 得到 `<div>ok</div>`；读 fixture 断言 `fixtureVersion === 1` 且 `valid.blocks` 有 13 种 `type`。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run app/lib/lesson-blocks`，预期 FAIL（tsx 未被收录 / fixture 不存在）。
- [ ] **Step 3: 实现**：改 `vitest.config.ts`，写类型，拷 fixture（`resolveJsonModule` 若未开则在 `tsconfig` 打开，并说明理由）。
- [ ] **Step 4: 跑测试确认通过**：`npx vitest run`（全量，确认原有测试不受影响）、`npx tsc --noEmit`。
- [ ] **Step 5: 提交**：`git commit -m "chore: add tsx test support, lesson block types and canonical fixture"`

---

### Task 15: 行内 Markdown 渲染器

**Files:**
- Create: `app/lib/lesson-blocks/inline.tsx`、`inline.test.tsx`

**Interfaces:**
- Produces：`renderInline(text: string): React.ReactNode`（手写小解析器，不引 Markdown 库）：`**`→`<strong>`、`*`→`<em>`、`==x==`→`<strong>`、`` `x` ``→`<code>`、`[t](u)`→`<a>`（仅 `isAllowedInlineHref(u)` 为真：协议 http/https/mailto，大小写不敏感；带 `target="_blank" rel="noopener noreferrer"`，`mailto:` 不加 `target`），换行→`<br />`，`\` 转义取字面；不合法或未闭合的标记当普通文字；所有文本走 React 文本节点（不使用 `dangerouslySetInnerHTML`）。同文件导出 `isAllowedInlineHref(href: string): boolean`。

- [ ] **Step 1: 写失败的测试**（`renderToStaticMarkup`）：各标记正确；`[x](javascript:alert(1))`、`[x](data:text/html,a)`、`[x](/relative)`、`[x](//evil.com)` → 只输出文字 `x`、无 `<a>`；`https://a.com` 链接含 `rel="noopener noreferrer"` 与 `target="_blank"`；**Review-focus（注入）**：`<img src=x onerror=alert(1)>`、`<script>x</script>` 被转义成文字（输出含 `&lt;img`）；`\*not bold\*` → 字面 `*not bold*`；未闭合的 `**abc` 不抛、原样输出；嵌套 `**a *b* c**` 正确；空串返回空。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run app/lib/lesson-blocks/inline`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: render the inline markdown subset for lesson blocks"`

---

### Task 16: 块渲染器（8 种简单块）+ 样式

**Files:**
- Create: `app/components/lesson-blocks/` 下 `SimpleBlocks.tsx`、`CopyButton.tsx`、`SimpleBlocks.test.tsx`
- Modify: `app/globals.css`（只**新增**类，不改任何已有规则）

**Interfaces:**
- Consumes: 任务 14 类型、任务 15 `renderInline`。
- Produces：组件 `HeadingBlock`、`ParagraphBlock`、`ListBlock`（bullet/numbered 共用）、`CodeBlock`、`StepBlock`、`CalloutBlock`、`DividerBlock`，签名均为 `({ id, props }: { id: string; props: <对应 props 类型> }) => JSX.Element | null`；`CopyButton({ text }: { text: string })`：点击写剪贴板，按钮文字 `Copy` → `Copied`（成功）/ `Copy failed`（失败），1.8 秒后复位，有可访问名称与焦点样式。视觉：`heading`/`paragraph`/列表/`divider` 直接用 `.lesson-markdown` 现有元素样式；`code` 复用 `.lesson-code-block` 结构（`terminal` 标签前 `>_`，`file` 显示 `FILE  <label>`，`plain` 只显示 `language`）；`step` 的数字方块沿用课时头部序号方块样式；`callout` 三种 variant 用 `--primary-pale`/状态绿/`--amber`+`--peach`。新增 CSS 一律包在容器查询里：`.lesson-blocks { container-type: inline-size; }`，≤ 480px 紧凑。heading 渲染 `h2`/`h3` 并带 `id={blockId}` 锚点；空文本标题返回 `null`。

- [ ] **Step 1: 写失败的测试**：每个组件至少一个结构断言——heading level 2/3 对应 `h2`/`h3` 且有 `id`，空文本返回空串；paragraph 里行内标记生效；列表过滤空项且 bullet 为 `ul`、numbered 为 `ol`；code 三种 `kind` 的标签文字（`>_`、`FILE  main.ts`、`plain` 只语言名）、`code` 内容被转义（`<b>` 变 `&lt;b&gt;`）、含 Copy 按钮且有 `aria-label`；step 显示编号与标题；callout 三种 variant 各有对应 class；divider 为 `hr`。样式用例：`globals.css` 里新类都以 `.lesson-blocks` 或 `.lb-` 前缀开头（读文件断言，防止污染全局）。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run app/components/lesson-blocks`，预期 FAIL。
- [ ] **Step 3: 实现**，并用 mock 页面（`mockups/2026-10-01-lesson-blocks-mock.html`）对照类名与间距。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: render simple lesson blocks reusing existing lesson styles"`

---

### Task 17: 块渲染器（table / image / resourceLink / annotatedCode / diagram）

**Files:**
- Create: `app/components/lesson-blocks/ComplexBlocks.tsx`、`ImageLightbox.tsx`、`ComplexBlocks.test.tsx`
- Modify: `app/globals.css`（只新增）

**Interfaces:**
- Consumes: 任务 14–16。
- Produces：`TableBlock`、`ImageBlock({ id, props, assets }: { …; assets: LessonAssets })`、`ResourceLinkBlock`、`AnnotatedCodeBlock`、`DiagramBlock`（签名同任务 16，`ImageBlock` 多一个 `assets`）。`table`：2px `--ink` 边框 + 4px 圆角、表头 `--surface-container`、外层 `overflow-x:auto`，单元格走 `renderInline`；`image`：按 `assets[assetId]` 取 `url`，缺失 → 虚线占位（文字 `图片缺失`，学员端也要有占位，不抛）；有 `caption` 渲染 `<figcaption>`；点击放大（`ImageLightbox`，Esc 关闭，焦点回到触发元素）；`resourceLink`：沿用 `.lesson-activity` 卡片造型，外链 `target="_blank" rel="noopener noreferrer"`，URL 再过 `isAllowedInlineHref`（不合法则渲染成不可点击的卡片）；`annotatedCode`：每步 `STEP n` 标签 + 独立 Copy，容器 ≥ 640px 左右分栏、否则上下堆叠（容器查询），讲解与 `terms` 走 `renderInline`；`diagram`：纵向节点卡 + 连接标签，`connections` 按 `from`→`to` 排在节点之间，悬空连接忽略不抛。

- [ ] **Step 1: 写失败的测试**：table 列头与单元格内容、单元格行内加粗；image 有素材 → `<img src alt>`、无素材 → 含 `图片缺失` 占位且无 `<img>`、`caption` 在 `figcaption`；resourceLink 外链属性、`javascript:` URL → 无 `<a>`；annotatedCode 渲染 N 个 `STEP` 标签与 N 个 Copy 按钮、`terms` 出现；diagram 节点顺序与连接标签正确、悬空连接不抛；对 `props` 缺字段（如 table 缺 `rows`）的调用**不应**由本层兜底——抛出由任务 18 的错误边界接住，本任务测试只覆盖合法 props。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run app/components/lesson-blocks/ComplexBlocks`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**，同 Step 2。
- [ ] **Step 5: 提交**：`git commit -m "feat: render table, image, link, annotated code and diagram blocks"`

---

### Task 18: `LessonBlocks` 总入口 + 接入 `CourseLessonContent` + API 类型

**Files:**
- Create: `app/components/lesson-blocks/LessonBlocks.tsx`、`LessonBlocks.test.tsx`、`BlockErrorBoundary.tsx`
- Modify: `app/components/CourseLessonContent.tsx`、`app/lib/api.ts`（`ApiLesson` 增加 `blocks?: RawLessonBlock[] | null`、`assets?: LessonAssets`，`markdown` 保留）、`app/workspace/page.tsx`（约 509 行：传 `blocks`、`assets`）

**Interfaces:**
- Consumes: 任务 16–17 的块组件。
- Produces：
  - `LessonBlocks({ blocks, assets, mode, problems }: { blocks: RawLessonBlock[]; assets: LessonAssets; mode: "learner" | "preview"; problems?: Array<{ blockId?: string; level: "error" | "warning"; message: string }> }): JSX.Element`：按 `type` 分派；**未知类型**与**组件渲染抛错**（`BlockErrorBoundary` 包住每一块）：`learner` 模式静默跳过（不渲染任何东西）；`preview` 模式渲染红色虚线占位，列出该块 `problems` 里对应 `blockId` 的消息（没有就写"该块无法渲染"）；`preview` 模式下 `level: "warning"` 的问题渲染成块旁的小标签。根元素 `<div className="lesson-blocks">`。
  - `CourseLessonContent` props 改为 `{ markdown?: string; blocks?: RawLessonBlock[] | null; assets?: LessonAssets }`：`Array.isArray(blocks)` → 渲染 `LessonBlocks`（`mode: "learner"`）；否则走原 Markdown 路径，**原路径一字不改**。

- [ ] **Step 1: 写失败的测试**：`LessonBlocks`——canonical `valid` 渲染出 13 种块各自的标志性元素；未知类型 `learner` 下输出里没有该块任何痕迹且不抛；某块 props 为 `null`（让组件抛）`learner` 下被跳过、其余块照常；`preview` 下同样两种情形出现红色占位（含 `class` 里的 `lb-invalid`）与消息；传入 `problems` 的警告出现标签。`CourseLessonContent`：`blocks` 为数组 → 块渲染；`blocks: null`/缺省 + `markdown` → 与改动前输出**逐字相同**（用改动前的实现快照对照）；`blocks: []` → 空渲染而不是回退 markdown（空课时是合法的）。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run app/components`，预期 FAIL。
- [ ] **Step 3: 实现**；`BlockErrorBoundary` 为 class 组件（React 19 的错误边界仍需 class），`renderToStaticMarkup` 不触发边界，故用"渲染前包一层 `try`"的纯函数 `safeRender(block)` 做可测试的兜底，错误边界只作为运行时第二道防线并在测试里单独验证其 `getDerivedStateFromError`。
- [ ] **Step 4: 跑测试确认通过**：`npx vitest run` 全量、`npx tsc --noEmit`、`npm run build`（确认 vinext 构建通过）。
- [ ] **Step 5: 提交**：`git commit -m "feat: render lesson blocks in CourseLessonContent with markdown fallback"`

---

### Task 19: `/preview/lesson` 预览页 + 与标准课时数据对齐

**Files:**
- Create: `app/preview/lesson/page.tsx`、`app/preview/lesson/PreviewClient.tsx`、`app/lib/lesson-blocks/preview-message.ts`、`preview-message.test.ts`、`app/lib/lesson-blocks/canonical-render.test.tsx`
- Modify: `.env.example`（加 `NEXT_PUBLIC_ADMIN_ORIGIN`）；client 的响应头配置（`next.config.*` 的 `headers()` 或 vinext 对应机制）

**Interfaces:**
- Produces：
  - `parsePreviewMessage(event: { origin: string; data: unknown }, adminOrigin: string | undefined): PreviewPayload | null`（纯函数）：`adminOrigin` 未配置、`event.origin !== adminOrigin`（精确字符串比较，不做 `startsWith`/`includes`）、`data` 非对象或 `data.type !== "lesson-preview"` → `null`；否则返回 `{ lesson: { title: string; moduleTitle: string }; blocks: RawLessonBlock[]; assets: LessonAssets; problems: Problem[] }`，`blocks` 不是数组按 `[]`、`assets` 缺失按 `{}`、`title`/`moduleTitle` 非字符串按空串、`problems` 非数组按 `[]`。消息形状 = spec 第 9 节，**外加可选 `problems`**（后台把 server 校验结果带来，用于占位上的详细说明，已写回 spec）。
  - 预览页 `PreviewClient`：挂载时 `window.addEventListener("message", …)` 用 `parsePreviewMessage`（`adminOrigin` 取 `process.env.NEXT_PUBLIC_ADMIN_ORIGIN`），收到有效消息就渲染课时头部（标题、模块名）+ `LessonBlocks`（`mode: "preview"`）；挂载后向 `window.parent` 发 `{ type: "lesson-preview-ready" }`，**目标 origin 为 `adminOrigin`**（未配置则不发）；初始显示"等待后台发送内容"。页面不读 Cookie / localStorage / token，不发任何网络请求，不引入登录守卫。
  - 响应头：`/preview/lesson` 加 `Content-Security-Policy: frame-ancestors <NEXT_PUBLIC_ADMIN_ORIGIN>`（未配置则 `frame-ancestors 'none'`），并加 `Cache-Control: no-store`；**其他页面不变**。

- [ ] **Step 1: 写失败的测试**
  - `preview-message.test.ts`（Review-focus 1）：白名单 origin + 合法数据 → 返回载荷；origin 为 `https://evil.com`、`https://admin.example.com.evil.com`、`http://admin.example.com`（协议不同）、空串 → `null`；`adminOrigin` 为 `undefined` → 一律 `null`；`data` 为 `null`、字符串、`{ type: "other" }` → `null`；白名单 origin 但 `blocks: "x"`、`assets: null`、块 `props` 为 `null` → 返回载荷且 `blocks: []`/`assets: {}`（不抛）。
  - `canonical-render.test.tsx`：用 canonical `valid` 经 `LessonBlocks` 渲染（`mode: "learner"`），断言 13 种块各自的关键结构（与任务 18 共用断言，抽成 helper）；`invalid` 里每个样例在 `preview` 模式下至少出现一个 `lb-invalid` 占位或警告标签，在 `learner` 模式下不抛。
  - 响应头：把"为预览页生成头"抽成纯函数 `previewHeaders(adminOrigin?: string): Record<string, string>` 并测试两种配置。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run app/lib/lesson-blocks`，预期 FAIL。
- [ ] **Step 3: 实现**，把 `previewHeaders` 接到 client 现有的响应头机制；`.env.example` 写注释"后台域名，不带结尾斜杠；未配置则预览页不接受任何消息"。
- [ ] **Step 4: 跑测试确认通过**：`npx vitest run` 全量、`npx tsc --noEmit`、`npm run build`；本地起 `npm run dev`，用 `curl -sI localhost:<port>/preview/lesson` 确认响应头含 `frame-ancestors`；再用一个临时 HTML（不同端口）iframe 嵌入并 `postMessage` canonical 数据，目测渲染与 mock 一致；非白名单端口发来的消息无反应。
- [ ] **Step 5: 提交**：`git commit -m "feat: add lesson preview page that accepts allowlisted postMessage only"`

---

## 自检（对照 spec）

| spec 章节 | 对应任务 |
|---|---|
| 3 数据模型（信封、上限、`body` 保留） | 1、3；`content` 列在 block 1 任务 2（修订） |
| 4 块清单 + 行内子集 | 1、2（server schema）、15–17（client） |
| 5 渲染规则（视觉沿用、容器查询、主题、未知块） | 15–18 |
| 6 校验（错误/警告/写草稿/发版） | 3、10、11 |
| 7 server 接口（`blocks`/`assets`/`markdown` 回退） | 8、18 |
| 8 Markdown→块 + 回填检查点 | 5、6、7、9 |
| 9 client 改动（渲染器、预览页、类型、对齐数据） | 14、18、19、4 |
| 10 上线顺序 | 执行顺序表 |
| 12 新建课程、素材上传 | 12、13、11（首次发版规则） |
| 13 对其他 spec/计划的影响 | B1 计划开头的修订节、block 4 spec 第 13 节（均已完成） |
| 迁移到 monorepo（block 4 spec 第 11 节步骤 0 的 api 部分） | 0 |
| 14 测试 | 各任务 Step 1；e2e 在任务 13 |

**本计划对 spec 的 3 处补充**（已写回 spec）：行内反斜杠转义；写草稿时信封非对象或 > 256 KB 直接 400（其余有错照存）；预览消息可选 `problems`。`GET /admin/courses/:slug/draft` 是 block 1 路由表遗漏、spec 第 12 节要求的，在任务 12 补上。

**不在本计划里：** `apps/admin` 与 `packages/admin-contract` 的建立；后台编辑界面（block 4）；语法高亮；UI 导入 `course.json`；迁移 B；client `feature/admin-panel-ui` 分支的处理——这几项等 Owen 决定。
