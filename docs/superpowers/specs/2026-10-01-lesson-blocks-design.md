# 课时块（Lesson Blocks）：结构化内容 + 配置化渲染

日期：2026-10-01
范围：`aivirteach-server`（schema、校验、摄取转换、课时接口）+ `aivirteach-client`（渲染器与预览页）。运营后台里的编辑界面在第 4 块。
实施计划：`docs/superpowers/plans/2026-10-01-lesson-blocks.md`（server 任务 1–13，client 任务 14–19）。
视觉基准：`mockups/2026-10-01-lesson-blocks-mock.html`（可点击，用 client 现有的配色和组件样式，含学员端 / 后台预览、浅色 / 深色、窄侧栏 / 宽布局和全部边界情况）。

## 1. 目标

运营在后台里改一节课时，不是改一大段文字，而是增删、排序、配置一个个"块"：标题、段落、代码、步骤、提示框、表格、图片、批注代码、流程图等。每个块只存"它是什么 + 属性"，怎么渲染由 client 按块类型决定。server 负责存储、校验和下发；后台预览显示的就是 client 的真实渲染。

## 2. 已确认的决定

| 决定 | 内容 |
|---|---|
| 存储 | 块 JSON 取代 Markdown：`CourseLesson.content Json`，一个有序块数组 |
| 渲染 | **client 自己渲染**（React，代码在 client 仓库）；server 不渲染、不发布 npm 包 |
| 后台预览 | 后台用 iframe 嵌入 client 的 `/preview/lesson` 页，用 `postMessage` 把草稿块发过去，保证和学员看到的一致 |
| 块的定义 | server 侧在 monorepo 的 `packages/lesson-blocks`（只有 zod schema + 块元数据，无 React），供发版校验和后台属性表单使用；client 渲染器自己写 TS 类型，两边靠同一份标准课时数据对齐 |
| 块范围 | v1 做 13 种（第 4 节）。不做交互型块（测验、完成按钮属于课时级组件，不是块） |
| 视觉 | **完全沿用 client 现有的样式**：`.lesson-markdown`、`.lesson-code-block`、`--ink` / `--surface-*` / `--outline` / `--primary` 等变量，深色主题自动生效。本 spec 只补"骨架"：把课时拆成可复用、可配置的块，不改视觉语言。client 里没有现成样式的块（step、callout、table 等）用同一套变量补，不引入新颜色体系 |
| 文字 | 块里的文字属性是行内 Markdown 子集（粗体、斜体、`==高亮==`、行内代码、链接、换行） |
| 未知 / 非法块 | 学员端静默跳过；后台预览显示红色占位并列出问题；发版校验拦截 |
| 新建课程 | 在后台界面从零新建（`POST /admin/courses` → 空草稿 v1），与已有课程共用同一套草稿编辑与发版；素材也在后台上传（第 12 节） |
| 语法高亮 | v1 不做（待 Owen 确认，见第 11 节） |

## 3. 数据模型

`CourseLesson.content Json?`，结构：

```json
{ "schemaVersion": 1, "blocks": [ { "id": "b-01", "type": "heading", "props": { "level": 2, "text": "..." } } ] }
```

- `id`：块 ID，课时内唯一，创建后不变（用于前端 key、锚点、后台选中）。1–64 字符。
- `type`：块类型，必须在 registry 里。
- `props`：该类型的属性，按第 4 节的 schema 校验。
- `schemaVersion`：预留给将来改块结构；v1 恒为 1。
- 上限：一节课最多 300 个块，整个 `content` 序列化后不超过 256 KB。
- 课时标题（H1）不是块，由课时头部渲染，来自 `CourseLesson.title`。

`body`（Markdown）在迁移 A 里保留，作为过渡期的回退；迁移 B 删除。草稿里编辑只写 `content`。

## 4. 块清单与属性

文本类属性（标记 *行内*）支持行内 Markdown 子集，其余当纯文本。所有长度是字符数。

| 块 `type` | 属性 | 说明 |
|---|---|---|
| `heading` | `level` 2\|3；`text` *行内* 1–200 | 没有 H1。H3 前面没有 H2 → 警告。空文本不渲染。带稳定 `id` 锚点 |
| `paragraph` | `text` *行内* 1–5000 | |
| `bulletList` / `numberedList` | `items` *行内* 数组，1–50 项，每项 ≤500 | 单层；空项丢弃 |
| `code` | `kind` terminal\|file\|plain；`language?` ≤30；`label?` ≤80；`code` 1–20000；`description?` *行内* ≤500 | `file` 必须有 `label`（显示 `FILE  文件名`）；`terminal` 标签前显示 `>_`；带 Copy 按钮；不换行、横向滚动 |
| `step` | `number` 1–99；`title` *行内* 1–120；`body?` *行内* ≤2000 | 编号应连续，不连续 → 警告 |
| `callout` | `variant` tip\|warning\|note；`title?` ≤60；`body` *行内* 1–2000 | |
| `table` | `columns` 1–8 列；`rows` ≤50 行，每行单元格数必须等于列数；单元格 *行内* ≤300 | 窄屏横向滚动。键值表也用它 |
| `image` | `assetId`；`alt` 1–300；`caption?` *行内* ≤300 | `assetId` 必须是本课程 `CourseAsset.id`；`alt` 必填；点击放大；资源缺失显示占位 |
| `resourceLink` | `url`（http/https/mailto）；`title` 1–120；`description?` *行内* ≤300 | 外链新标签页，`rel="noopener noreferrer"` |
| `divider` | 无 | |
| `annotatedCode` | `title?` ≤120；`fileLabel?` ≤80；`steps` 1–20 项，每项 `label` 1–80、`code` 1–10000、`explanationTitle?` ≤80、`explanation?` *行内* ≤1000、`terms` 0–10 项（`term` ≤60、`description` *行内* ≤300） | 容器够宽（≥640px）时左代码右讲解，窄（侧栏）时上下堆叠；每步有 `STEP n` 标签和独立 Copy |
| `diagram` | `title?` ≤120；`nodes` 2–12 个（`id`、`title` ≤60、`description?` ≤200）；`connections` 数组（`from`、`to`、`label?` ≤40） | v1 只做纵向流程，不做分叉和横向；`connections` 引用的节点必须存在 |

**行内 Markdown 子集：** `**粗体**`、`*斜体*`、`==高亮==`（渲染为加粗，无背景）、`` `行内代码` ``、`[文字](url)`、换行。链接只放行 http / https / mailto，其余当普通文字。反斜杠转义：`\*`、`\``、`\[`、`\]`、`\=`、`\\` 取字面字符（Markdown 转换时保证源文字里的字面符号不被当成格式）。不支持原始 HTML，所有文字一律转义。

## 5. 渲染规则（client）

**视觉原则：不换皮，只加骨。** 已有的元素（标题、段落、列表、代码块、分隔线）保持 client 现在的样式一字不改；新增块用同一套变量和同一种造型（2px `--ink` 边框、约 4px 圆角、`--surface-*` 底色）补。

| 块 | 视觉来源 |
|---|---|
| heading / paragraph / bulletList / numberedList / divider | 原样沿用 `.lesson-markdown` |
| code | 原样沿用 `.lesson-code-block`（深色代码底、顶栏标签、Copy 按钮，点击后 "Copied"，失败 "Copy failed"，1.8 秒复位） |
| step | 数字方块沿用课时头部序号方块（2px `--ink` 边框、`--ink` 底、等宽字） |
| callout | `note` 用 `--primary` / `--primary-pale`；`tip` 用状态绿；`warning` 用 `--amber` / `--peach`（这些变量 client 已有） |
| table | 2px `--ink` 边框 + 4px 圆角，表头 `--surface-container`，窄时横向滚动 |
| image | 2px `--ink` 边框 + 4px 圆角，点击放大；资源缺失显示虚线占位 |
| resourceLink | 沿用 `.lesson-activity` 的卡片造型 |
| annotatedCode / diagram | 代码部分沿用 `.lesson-code-block`；讲解卡、节点卡用 `--surface-low` / `--outline` 同一造型 |

**版面按容器宽度响应，不按屏幕宽度。** client 里课时目前只出现在 workspace 页面右侧的侧栏（`.sidebar-lesson`，宽度可拖动，字号 12px），将来也可能放进主区域。所以块用 CSS 容器查询：容器 ≤480px 时沿用侧栏的小字号和紧凑间距，≥640px 时批注代码才左右分栏。

**主题：** 只引用 client 的变量，浅色 / 深色自动跟随，不另做深色样式。

**通则：** 文字一律转义；每个块带稳定 `id`；语义化标题层级；按钮有可访问名称、有焦点样式；尊重 `prefers-reduced-motion`。

**未知或非法块：**
- 学员端：跳过，不显示任何报错。
- 预览模式：红色虚线占位，列出该块的校验错误和警告。

**图片：** 课时响应带 `assets`（见第 7 节），client 按 `assetId` 取地址。

## 6. 校验

校验放在 `packages/lesson-blocks`，纯 zod，无 React。三个时机：写草稿时（`PATCH /draft/lessons/:contentId`）、发版时（整版再验一遍）、摄取转换后。

**错误（拦截发版）：** 未知块类型；属性不符合 schema；块 `id` 在课时内重复；`image.assetId` 不是本课程资源；`image.alt` 为空；`resourceLink.url` 非法；`table` 行列数不一致；`diagram` 连接指向不存在节点；超过数量或体积上限。

**警告（提示，不拦截）：** `step` 编号不连续；H3 前面没有 H2；`heading` 文本为空（不渲染）；整节课没有任何块。

写草稿时：有错误的内容也允许保存（运营可能在编辑中途），响应里带上问题列表；唯一例外是 `content` 不是对象、或序列化后超过 256 KB——这种直接 400 不保存（防止存垃圾和超大请求）；发版时全部错误一次性列出，422，不产生部分写入。这一点替换 block 1 spec 里"每节 `body` 非空"的发版校验：改为"每节至少一个会渲染的块，且无错误"。

## 7. server 接口

学员读课 `GET /courses/:courseId/lessons/:lessonId` 增加：

- `blocks`：来自 `content.blocks`。
- `assets`：`{ [assetId]: { url, alt? } }`，只包含该课时 `image` 块引用的资源（`CourseAsset.objectKey` 即 Blob 公开地址）。
- 保留 `markdown`（来自 `body`），标记为弃用，迁移 B 之后删除。

**client 的回退规则：** 响应有 `blocks` 且为数组 → 渲染块；否则渲染 `markdown`。回填完成后所有课时都有 `blocks`，回退只在过渡期兜底。

后台草稿预览 `GET /admin/courses/:slug/draft/lessons/:contentId` 返回结构与学员读课一致（block 1 已有，由 `buildLessonResponse` 共用）。

## 8. Markdown → 块 的转换

用于两处：`course:create` 摄取 Labs 课程时、迁移 A 的回填（`body` → `content`）。同一个转换函数，只在 CLI 里用，API 进程不引入 Markdown 解析依赖（`remark` 系列用动态 `import()` 加载，因为是 ESM）。

| Markdown | 块 |
|---|---|
| `##` / `###` | `heading` level 2 / 3（`#` 一级标题是课时标题，丢弃并记警告；`####` 起降为 3） |
| 段落 | `paragraph`（行内格式映射到第 4 节的子集，超出子集的格式降为纯文本） |
| 无序 / 有序列表 | `bulletList` / `numberedList`（嵌套列表拍平并记警告） |
| 围栏代码 | `code`：语言为 `bash` / `sh` / `shell` / `console` / `zsh` → `terminal`；其余一律 `plain`（不猜是不是文件，文件名由运营在后台补成 `file`）；`language` 取围栏语言名，`label` 留空 |
| 表格 | `table` |
| `---` | `divider` |
| 图片 | `image`（`assetId` 按文件名对应课程资源；对不上则保留为带警告的占位段落） |
| 引用块 | `callout`（variant `note`） |
| 其他（原始 HTML 等） | 纯文本 `paragraph` + 警告 |

转换不会丢内容：任何无法映射的部分都降为 `paragraph` 并写进转换报告，由 Owen 在回填检查点审阅。回填检查点由原来的"`body` 与旧 `getLesson` 逐字一致"改为"块渲染成的纯文本与旧 `body` 的纯文本一致"。

## 9. client 的改动（在 client 仓库）

1. **渲染器**：把 `app/components/CourseLessonContent.tsx`（现在解析 Markdown，129 行）扩成按块渲染：块类型 → React 组件的映射，加样式。保留原 Markdown 路径作为回退。
2. **预览页** `/preview/lesson`：不登录、不拉任何数据，只接收 `postMessage`：

```ts
{ type: "lesson-preview", lesson: { title, moduleTitle, blocks }, assets: { [id]: { url, alt? } } }
```

   - 只接受来自配置里的后台域名（`NEXT_PUBLIC_ADMIN_ORIGIN`）的消息，其他来源忽略；后台一侧同样只向配置的 client 域名发送。
   - 消息可选带 `problems`（后台把 server 校验结果转发过来：`[{ blockId?, level, message }]`），预览模式用它在占位和警告标签上显示详细原因。
   - 预览模式开启"后台模式"：非法块显示红色占位、显示警告标签。
   - 预览页不带 Cookie、不写 localStorage、不读 token，不会泄露草稿。
3. **类型与对齐**：client 自己写块的 TS 类型。两边对齐靠 `packages/lesson-blocks/fixtures/canonical-lesson.json`（含全部 13 种块的合法样例和一组非法样例）：server 测试断言它的校验结果，client 测试用它渲染并断言关键结构。改块定义时，两边都要更新这份数据；这是已知的维护成本。
4. client 的发版节奏：渲染器 → server 回填 → 开放编辑，顺序见第 10 节。

## 10. 上线顺序

1. client 上线块渲染器和预览页（此时 server 还没有 `blocks`，走 `markdown` 回退，学员无感）。
2. server 迁移 A + 回填 `content`，课时响应开始带 `blocks`。
3. 观察期，确认转换报告无遗漏。
4. 开放后台编辑（block 4）。
5. 迁移 B：删除 `body`、`markdown` 字段。

## 11. 不在本 spec 范围内 / 待定

- **语法高亮**：v1 不做；若要加，只改 client 的 `code` 渲染，不影响存储格式。**待 Owen 确认。**
- **换肤 / 多套皮肤：** 不做。视觉随 client 的主题变量走，client 以后改主题，所有课时自动跟着变。
- **学习配置**（Practice / Completion / Assessment 三个 tab）：参考页里有，数据模型与 server 现有的 `activity*` / `LessonAssessment` 对不上，且学员侧要去掉正确答案，另起一份设计。
- **交互型块**、嵌套列表、分叉 / 横向流程图：不做。
- client 仓库的 `feature/admin-panel-ui` 分支（8 月 24 日，在 client 里做了一套 admin 界面）与"运营后台放 server 仓库"冲突，需 Owen 确认处理方式。

## 12. 新建课程与素材上传（走后台界面）

之前的设计里，新课程只能靠 CLI `course:create` 从 Labs 摄取，草稿又只能"从最新已发版复制"，后台没有从零开始的路径；图片块要求 `assetId` 是本课程素材，但后台也没有上传素材的入口。本节补上这两处，让运营从新建课程到发版全程在后台完成。

**新建课程**

`POST /admin/courses`，body：`{ slug, title }`（其余元信息之后在草稿里补）。

- `slug`：小写字母、数字、连字符，3–60 字符，全局唯一（重复返回 409）；创建后不可改（学员路由用它）。
- 一个事务内创建：`Course`（`published=false`，`contentId` 为空，这是 schema 已允许的）+ 第一个 `CourseVersion`（版本号 1，`publishedAt` 为空，即草稿）+ 一个空的欢迎页。草稿里没有模块、没有课时。
- 写 `AuditEvent`（操作人、slug）。
- 之后的编辑走和已有课程相同的草稿接口（`PATCH /draft` 改元信息，`POST /draft/modules`、`POST /draft/modules/:id/lessons` 加模块和课时）。新建课程不引入第二套编辑流程。
- 首次发版：校验规则相同，另加"至少一个模块且每个模块至少一节课"。发版成功后 `Course.published` 才变为 true，在此之前学员的课程列表看不到它。
- 没有已发版版本时，`GET /admin/courses/:slug/draft` 直接返回现有草稿，`POST /draft` 返回现有草稿（不会报"无可复制版本"）。

后台课程列表页新增"新建课程"按钮：输入 slug 和标题 → 创建 → 跳转到课程编辑页。

**素材上传**

`POST /admin/courses/:slug/assets`（`multipart/form-data`，字段 `file`、可选 `altText`）。

- 仅限图片：`image/png`、`image/jpeg`、`image/webp`、`image/gif`；单个文件 ≤ 5 MB；服务端按文件头校验类型，不信任客户端报的 `Content-Type`。SVG 不收（可内嵌脚本）。
- 存入 Vercel Blob（沿用 `CourseAssetStorageService.upload`，路径含课程 id 和随机后缀，避免覆盖），写一条 `CourseAsset`，返回 `{ id, url, altText, mimeType }`。
- 素材属于课程本身，不随版本复制（block 1 已定）；上传后立即可用，草稿和已发版都能引用。
- 用途：图片块的 `assetId`、课程封面（`coverAssetId`）、欢迎页概览图（`overviewAssetId`）。块编辑器里的图片属性是"上传 / 从本课程素材中选择"，不让运营手填 id。
- 写 `AuditEvent`。素材不提供删除接口（图片可能被已发版内容引用）；清理是后续工作。

**不包含**

- **导入 `course.json` / Markdown 的界面**：参考页有这个按钮，但转换要用 `remark`，第 8 节决定它只在 CLI 里加载、不进 API 进程。v1 里 Labs 来的课程仍用 CLI 摄取；之后若要界面化，把转换放进一个单独的、动态加载的服务端函数即可，存储格式不受影响。**待 Owen 确认是否 v1 就要。**
- **`imageDigest`（实验室虚拟机镜像）**：当前代码只写入、没有任何地方读取（Workspace 编排尚未落地），v1 的新建课程不设置它；落地编排时再决定设置入口。
- 课程删除、下架、改 slug：不做。

## 13. 对其他 spec / 计划的影响

- **block 1 spec / 计划：** `body` 改为 `content Json`（`body` 过渡期保留）；写草稿与发版校验用本 spec 的块校验；`buildLessonResponse` 增加 `blocks`、`assets`；backfill 命令用第 8 节的转换；`course:create` 摄取时转换；计划里的路径改成 `apps/api/...`；`packages/lesson-blocks` 要先于这些任务建好。
- **block 1 spec / 计划（新建课程）：** 新增 `POST /admin/courses`、`POST /admin/courses/:slug/assets`；`POST /draft` 在无已发版版本时返回现有草稿；首次发版的额外校验；这两个接口同样挂 `OperatorAuthGuard` 并写审计。
- **block 4 spec：** 课程列表页加"新建课程"；块编辑器的图片属性用"上传 / 选择素材"；课时编辑器改成"块卡片 + 属性面板"（块列表带 Edit / Duplicate / Delete / 上移下移、"Add Content" 选择器、属性表单由 schema 生成），自动保存、保存状态、撤销、校验提示；预览改用 iframe 嵌 client 预览页（取代"admin 自己渲染一份"）；依赖顺序：lesson-blocks → client 渲染器 → 4b。

## 14. 测试

先写测试，覆盖率不低于 80%。

- 块 schema：每种块的合法 / 边界 / 非法输入；上限；行内 Markdown 的链接过滤。
- 标准课时数据：server 校验结果断言；client 渲染断言（同一份数据）。
- 转换：针对 `sample-course` 与若干构造输入，断言块序列与转换报告；无法映射的内容进入报告而不是丢失。
- 回填：纯文本等价检查。
- 发版：非法块拦截并一次性列出；警告不拦截；`image.assetId` 越权引用被拒。
- 课时接口：`blocks`、`assets` 的内容；只带被引用的资源；回退到 `markdown`。
- client：未知块学员端静默跳过、预览模式显示占位；预览页拒绝非白名单来源的消息。
- 新建课程：slug 格式与重复（409）；事务内创建 Course + 草稿 v1 + 欢迎页，失败不留残留；新课程发版前学员列表看不到；首次发版的"至少一个模块、每模块至少一节课"校验。
- 素材上传：类型按文件头校验（伪造 Content-Type 被拒、SVG 被拒）；超过 5 MB 被拒；跨课程引用素材被发版校验拦下；上传后写 `CourseAsset` 与审计。
