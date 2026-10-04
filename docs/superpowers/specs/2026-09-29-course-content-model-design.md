# 课程内容模型：每节独立正文 + 草稿/发版

日期：2026-09-29（2026-10-01 按"课时块"修订，见第 10 节）
范围：`aivirteach-server`（本 spec 只覆盖"第 1 块"，见末尾的整体拆分）

> **2026-10-01 修订：** 课时内容改存块 JSON（`content`），不再是 Markdown `body`；新增"新建课程"和"素材上传"接口。修订点集中在第 10 节，正文里受影响处已就地标注。块的定义见 `2026-10-01-lesson-blocks-design.md`。

## 1. 问题

运营现在没法安全地改课程内容：

- 一门课的全部正文存成一整块 `CourseVersion.sourceMarkdown`，每节课只存 `sourceRange {startLine, endLine}`（`courses.service.ts:155-171`）。改一节的中间内容，后面所有课时的行号都会错位。
- `course:create` 只能新建（slug 唯一），`course:publish` 只翻 `publishedAt`，没有任何更新路径。内容源头是磁盘上的内容目录。
- 读课取的是"版本号最大的一版"，不看 `publishedAt`（`COURSE_WITH_LATEST_VERSION_INCLUDE`），一旦出现草稿版本就会泄漏给学员。
- `Enrollment.courseVersionId` 在报名时记下版本，但读课不使用它，两者不一致。

## 2. 已确认的决定

| 决定 | 内容 |
|---|---|
| 运营改课的入口 | dashboard（admin API）和 Neon MCP 都可以写草稿 |
| 发版 | **只在 dashboard（admin API）里做**，不支持用 SQL 直接改 `publishedAt` |
| 生效时机 | 改动先存草稿，点"发版"之前学员什么都看不到 |
| 老学员 | 发版后老学员**立刻**看到新版；进度按课时 `contentId` 对应，不按行 id |
| 草稿放哪 | 用现有 `CourseVersion`：`publishedAt` 为空 = 草稿（版本快照方案） |
| 鉴权 | admin API 暂用环境变量 `ADMIN_API_TOKEN`；真正的运营账号留到第 4 块 |

## 3. 数据模型

1. **`CourseLesson.content`**：`Json?`，这一节的块数组（结构见课时块 spec 第 3 节）。`getLesson` 读它并下发 `blocks`。**`CourseLesson.body`**（`String @default("") @db.Text`，Markdown）在迁移 A 里同时加上，作过渡期回退，迁移 B 删除。`sourceMarkdown` / `sourceRange` 保留但不再读，以后单独删。
2. **一门课最多一个草稿**：唯一索引 `(courseId) WHERE publishedAt IS NULL`。Prisma 不支持部分唯一索引，在迁移里写原生 SQL。
3. **学员读取只认已发版**：读课、目录、欢迎页都过滤 `publishedAt IS NOT NULL`，取最大版本。这是对现有查询的修复，不是新增功能。
4. **进度按 `contentId` 存**：`Progress` 新增 `currentLessonContentId`，取代指向 `CourseLesson.id` 的外键 `currentLessonId`。原因：草稿由整体复制生成，课时行 id 每个版本都会变。
5. **`Enrollment.currentModuleId`** 去掉：模块由当前课时推出。当前代码里它只在重新开始时被置空（`enrollments.service.ts:77`）。
6. **`Enrollment.courseVersionId`** 保留为"报名时的版本"记录，不再决定读哪一版。
7. **摄取**：`course:create` 摄取时直接把每节正文切出来写进 `body`。

## 4. 编辑与发版

写入路径有两条，写的是同一批草稿行：

- **admin API**（`Authorization: Bearer $ADMIN_API_TOKEN`），路径都挂在 `/admin/courses/:slug` 下：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/draft` | 返回当前草稿（修订新增） |
| POST | `/draft` | 从最新已发版整体复制出草稿（模块、课时含 `content`、欢迎页、测评题）；已有草稿则直接返回。课程封面等 `CourseAsset` 属于课程本身，不随版本复制 |
| DELETE | `/draft` | 丢弃草稿 |
| PATCH | `/draft` | 改课程元信息 |
| PATCH | `/draft/welcome` | 改欢迎页 |
| POST | `/draft/modules` | 新增模块 |
| PATCH / DELETE | `/draft/modules/:moduleId` | 改 / 删模块 |
| POST | `/draft/modules/:moduleId/lessons` | 在模块里新增课时 |
| PATCH / DELETE | `/draft/lessons/:contentId` | 改 / 删课时（标题、`content`、目标、activity）；写 `content` 时做块校验，有错也保存并返回问题列表 |
| PUT | `/draft/order` | 一次提交完整的模块与课时顺序（也用来把课时移到别的模块） |
| PATCH | `/draft/assessments/:assessmentId` | 改测评题 |
| GET | `/draft/lessons/:contentId` | 草稿预览，返回结构与学员读课接口完全一致（供第 2 块的预览路由使用） |
| POST | `/publish` | 发版 |
| POST | `/admin/courses`（不挂 `:slug`） | 新建课程：`{ slug, title }` → 课程 + 空草稿 v1（修订新增，见课时块 spec 第 12 节） |
| POST | `/assets`（挂在 `/admin/courses/:slug` 下） | 上传图片素材（修订新增，同上） |

  路径里的标识：课时用 `contentId`（跨版本稳定、版本内唯一）；模块和测评题没有 `contentId`，用草稿里的行 id（同一份草稿内稳定，丢弃重建后会变）。
- **Neon MCP**：对草稿版本的行直接写 SQL，适合日常改文字和元信息。

**依赖：** 不新增 npm 包。请求校验用现有的 `zod` 和 `ZodValidationPipe`；鉴权写一个 guard，令牌用 `node:crypto` 的 `timingSafeEqual` 比较；`ADMIN_API_TOKEN` 加进 `src/config/env.ts` 的 `EnvSchema`，必填、至少 32 个字符（与 `JWT_SECRET` 一致），缺了启动就崩。接口限流不在本 spec 内（现有接口也没有）。

**运营怎么用（第 4 块的页面做出来之前）：** 日常改文字和元信息走 Neon MCP；创建草稿、增删课时、排序、发版走 admin API（curl 或脚本）。这一块没有界面，页面在第 4 块。

**发版（一个事务）：**

1. 校验草稿：每节 `content` 至少一个会渲染的块且块校验无错误（原"每节 `body` 非空"已替换）；课时 `contentId` 不重复；位置连续；至少一节课；引用的封面和图片存在；首次发版另加"至少一个模块、每个模块至少一节课"。所有问题一次性列出，任何失败都不产生部分写入。
2. 按该版本重算 `Course.lessonCount` 与 `durationMinutes`。
3. 设置 `publishedAt`。
4. 写一条 `AuditEvent`（谁、什么时候、发了哪个版本）。已发版再点发版：无副作用。

**取舍：**

- 绕过 API 直接 `UPDATE publishedAt` 会跳过校验和汇总更新，不是支持的路径，运营文档里明确写出。
- Neon MCP 的改动不进 `AuditEvent`，只有 admin API 的改动有审计。

## 5. 迁移

**数据库迁移在执行前，先在可视化页面做前后对比，由 Owen 检查通过后才执行。** 不在未检查的情况下对任何数据库跑迁移。

分两份迁移，中间隔着数据回填、代码切换和观察期：

**迁移 A（只加不删，可回滚）**

- 加 `CourseLesson.body`、`CourseLesson.content`、`CourseVersion` 部分唯一索引、`Progress.currentLessonContentId`。
- 回填脚本（可重复运行）：按现有行号切出每节正文填入 `body`；再把 `body` 转成块写入 `content`（转换规则见课时块 spec 第 8 节）；从旧课时行回填 `currentLessonContentId`。检查点：`body` 与旧 `getLesson` 返回的逐字一致；`content` 渲染成的纯文本与 `body` 的纯文本一致（转换报告由 Owen 审阅；转换不合格的课时不写 `content`，学员继续走 `markdown` 回退）；进度回填数量一致。旧 `currentLessonId` 指向的课时行找不到时：该条不回填，脚本把这些 `Progress` 行列出来，由 Owen 决定怎么处理，不静默丢弃。

**代码切换**：读 `content`（`blocks`）并保留 `body` 作 `markdown` 回退，只读已发版的最大版本，进度按 `contentId`（涉及 `courses.service.ts`、`enrollments.service.ts`、`enrollment-status.ts`）。

**迁移 B（不可逆，观察期后才做）**：删除 `Progress.currentLessonId` 和 `Enrollment.currentModuleId`。执行前先备份。

## 6. 出错处理

- 发版校验失败：422，返回完整问题列表。
- 学员停在被删的课时：进度指向的 `contentId` 在新版里找不到时，跳到被删位置之后的下一节；后面没有课时则落在最后一节。
- 草稿不存在：编辑接口返回 404，提示先创建草稿。
- 令牌缺失或错误：401。

## 6.1 已知限制

- `Attempt` 通过外键指向具体版本的 `LessonAssessment` 行，草稿复制会生成新的题目行，旧作答记录仍留在旧行上。目前测评表是空的，暂不处理；等测评内容落地时，再决定按题目 `contentId` 对应还是别的做法。
- Neon MCP 的改动没有审计记录（见第 4 节）。

## 7. 测试

先写测试，覆盖率不低于 80%。

- 迁移：用 `sample-course` 测试数据，回填出的正文与旧行号切片逐字一致。
- 可见性：草稿怎么改，学员的读课、目录、欢迎页接口都拿不到。
- 发版：各种校验失败；汇总数据被更新；重复发版无副作用；审计事件被记录。
- 进度：发版时删课时、调顺序、加课时，学员进度都落在正确位置。
- admin API：无令牌、错令牌都拒绝。
- 环境变量：缺 `ADMIN_API_TOKEN` 或不足 32 个字符时，`loadEnv` 抛错并指名字段（同时更新 `env.spec.ts`）。

## 8. 不在本 spec 范围内（整体拆分）

| # | 内容 | 依赖 |
|---|---|---|
| 1 | **本 spec**：server 内容模型 | 无 |
| 2 | client 渲染与预览：**已改为课时块 spec**——client 按块渲染（沿用现有样式，不做皮肤）+ `/preview/lesson` 页，见 `2026-10-01-lesson-blocks-design.md` | 1 |
| 3 | client 部署：当前按 Cloudflare Workers 构建（vinext + `@cloudflare/vite-plugin`），要决定改标准 Next 上 Vercel 还是沿用 Cloudflare | 无 |
| 4 | 运营后台页面（课程列表 / 课时编辑 / 预览 / 发版）与真正的运营账号 | 1、2、3 |
| 5 | Python Basics 迁进 server；删除 client 里 `courseCatalog` 假数据 | 1 |

## 9. 计划阶段补充的决定（2026-09-30）

写计划时对着代码发现的、第 1–8 节没覆盖或与代码不符的地方：

1. **课程元信息也要走草稿。** 标题、简介、标签等在 `Course` 表里，不随版本走，直接改会绕过"发版前学员看不到"。补一列 `CourseVersion.meta Json?`：`PATCH /draft` 只写这一列，发版时在同一事务里应用到 `Course`。创建草稿时不复制 `meta`。
2. **`CourseLesson.sourceRange` 改为可空**（迁移 A 里 `DROP NOT NULL`）。草稿里新增的课时没有行号。
3. **迁移 A 的内容因此是：** `CourseLesson.body`、`CourseLesson.sourceRange` 可空、`CourseVersion.meta`、`Progress.currentLessonContentId`、部分唯一索引。
4. **删课时后的进度重映射在发版事务里做**（第 6 节的规则需要旧版本顺序，读课时已经没有了）。已学完（指针为空）的学员不动。
5. **`contentId` 数据库只保证"模块内唯一"**，按 `contentId` 定位需要"版本内唯一"：发版校验强制；`PATCH/DELETE /draft/lessons/:contentId` 遇到重名返回 409；`contentId` 创建后不可通过 API 修改。
6. **发版校验里"引用的图片存在"**只检查 `Course.coverAssetId` 和欢迎页的 `overviewAssetId`（非空时必须是本课程 `CourseAsset` 的 id）。`introFeaturedAssetIds` 现存的是作者侧素材名（如 `cover`），不是 `CourseAsset.id`，不校验。
7. **汇总口径：** `lessonCount` = 课时总数；`durationMinutes` = 各课时 `estimatedMinutes` 之和。
8. **审计：** admin API 的每个写接口都写 `AuditEvent`（actor = `OPERATOR`，id 取请求头 `X-Operator`，必须是邮箱）。共用一个令牌，`X-Operator` 是自报的，不是身份认证；真正的账号在第 4 块。
9. **CLI `course:publish` 保留**，改为调用同一个发版服务（同样校验、同样审计），不再是直接翻 `publishedAt`。
10. **spec 第 5 节写的 `enrollment-status.ts` 实际是 `enrollment-view.ts`；** 另外 `dashboard.service.ts`、`chat.service.ts` 也读 `currentLessonId` / `courseVersion`，一并在代码切换里改。
11. **`Enrollment.currentModuleId` 去掉后，响应里的 `currentModule` 由当前课时推出**（现在它实际上一直是空串，改完会开始返回真实模块名）。

## 10. 2026-10-01 修订：课时块

- **存储：** `CourseLesson.body`（Markdown）→ `content Json`（块数组）。`body` 过渡期保留，迁移 B 删除。第 3 节第 1 条、第 4 节草稿复制/课时编辑/发版校验、第 5 节回填与检查点、第 8 节第 2 项已就地修订。
- **校验：** 写草稿与发版用 `packages/lesson-blocks` 的块校验（错误拦截发版、警告不拦截；写草稿时有错也保存并返回问题列表）。
- **读课接口：** 响应新增 `blocks` 与 `assets`，`markdown`（来自 `body`）标记弃用；`buildLessonResponse` 草稿预览与学员读课共用。
- **新增接口：** `GET /draft`、`POST /admin/courses`（新建课程）、`POST /admin/courses/:slug/assets`（素材上传）；`POST /draft` 无已发版版本时返回现有草稿；未发版课程的唯一草稿不可丢弃（409）。
- **摄取与回填：** `course:create` 摄取时同时写 `body` 与 `content`（Markdown→块转换，只在 CLI 里加载 remark）；回填命令同样转换。
- **第 9 节第 6 条** 的"引用的图片存在"在块之后还包括每个 `image.assetId` 必须属于本课程。
- **实施：** 路径改为 monorepo 的 `apps/api/...`；任务顺序与"接入块"的改动见 `plans/2026-09-30-course-content-model.md` 开头的修订节和 `plans/2026-10-01-lesson-blocks.md`。
