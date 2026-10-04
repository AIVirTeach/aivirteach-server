# 运营后台：运营账号 + Next.js 管理界面 + 改动来源区分

日期：2026-10-01
范围：整体拆分里的"第 4 块"（见 `2026-09-29-course-content-model-design.md` 第 8 节）。依赖第 1 块（课程内容模型 + admin API，已有 spec 和 plan）；课程编辑页还依赖课时块 spec（`2026-10-01-lesson-blocks-design.md`）：块定义、client 渲染器和预览页。

> **2026-10-01 修订：** 新建课程与素材上传进入第一版；编辑器改成块卡片 + 属性面板并带自动保存；预览改为 iframe 嵌 client 的真实渲染，不再自己实现渲染器。就地修订处都已改，汇总见第 13 节。

## 1. 目标

运营不用 CLI、curl 或 SQL，就能在网页里改课程、发版、邀请学员、发配额、查审计；并且任何一条改动都能看出是**运营做的还是学员做的**。

使用者是内部运营，少数人，权限相同。学员没有任何改课程内容的入口。

**第一版做：** 课程（列表、**新建课程**、版本状态、元信息、模块/课时编辑、**块编辑与图片素材上传**、真实渲染预览、测评题、发版、丢弃草稿）、邀请、配额（发放与发放记录）、审计（只读）。

**第一版不做：**

- 在界面里**导入** `course.json` / Markdown：转换依赖 remark，只在 CLI 里加载，Labs 来的课程继续用 CLI `course:create`（新建空课程走界面，见课时块 spec 第 12 节；是否 v1 就要导入界面待 Owen 确认）。
- 演示 mock 里的 Neon MCP 抽屉：那是外部工具，不是界面功能。
- 权限分级、多因素登录、配额余额与扣减（`QuotaLedger` 目前只有"发配额"一个写入口，没有任何代码读取它）。

## 2. 已确认的决定

| 决定 | 内容 |
|---|---|
| 界面放哪 | server 仓库内，不新开仓库（架构图：server 是唯一连数据库的一方，client 是 Tauri 学员应用） |
| 界面技术 | Next.js 16 App Router + React + Tailwind + shadcn/ui |
| 仓库结构 | monorepo：`apps/api`（现有 Nest 整体搬入）、`apps/admin`、`packages/admin-contract` |
| 包管理 | npm workspaces；先不加 Turborepo（只有两个应用，收益小，需要时再加） |
| 账号 | 单独的 `Operator` 表和登录，与学员账号完全隔离 |
| 权限 | 少数人，权限相同，不分级 |
| 预览渲染 | **不自己渲染**：iframe 嵌 client 的 `/preview/lesson`，用 `postMessage` 发草稿块，显示的就是学员会看到的渲染（课时块 spec 第 9 节）；admin 只需配置 client 域名 `NEXT_PUBLIC_CLIENT_ORIGIN`（只向它发消息）|
| 数据访问 | `apps/admin` 只调用 `apps/api` 的 HTTP 接口，不直接连数据库 |
| 部署 | `apps/api` 与 `apps/admin` 是同一仓库里的两个 Vercel 项目（各自的 Root Directory） |

## 3. 仓库结构

```
aivirteach-server/
├── apps/api/                  现有 Nest：src、prisma、test、nest-cli.json 等整体搬入
├── apps/admin/                Next.js 16 运营后台
├── packages/admin-contract/   admin API 的 zod schema 与类型，api 和 admin 共用
├── docs/                      不动（spec、plan 仍在仓库根）
└── package.json               只声明 workspaces
```

- `packages/admin-contract` 的作用：Nest 用它校验请求，Next 用它构造请求和解析响应，字段改了两边一起报错。第一版只放本 spec 和第 1 块新增的 admin 接口 schema。
- 搬迁必须排在第 1 块执行之前（否则第 1 块的所有改动搬两次）。搬迁会改动线上 Vercel 项目的 Root Directory，是单独的一步，有关卡（第 11 节）。

## 4. 运营账号与登录

**数据模型（迁移，执行前照旧由 Owen 看前后对比页）：**

- `Operator`：`id`、`email`（唯一）、`passwordHash?`、`status`（`INVITED | ACTIVE | DISABLED`）、`failedLoginCount`（默认 0）、`lockedUntil?`、`createdAt`、`updatedAt`。
- `OperatorRefreshToken`：结构与 `RefreshToken` 一致（`tokenHash` 唯一、`expiresAt`、`revokedAt?`、`replacedBy?`），外键指向 `Operator`，级联删除。
- `OperatorSetupToken`：`operatorId`、`tokenHash`（唯一）、`expiresAt`、`usedAt?`；用于首次设置密码和重置密码。
- `AuditEvent` 加 `@@index([createdAt])`（审计页按时间倒序翻页用）。

**令牌：** 复用 `src/auth/tokens.ts` 的签名与验证，audience 用 `aivirteach-admin`（学员是 `aivirteach-client`），所以学员令牌调不了 admin API，反过来也一样。签名密钥沿用 `JWT_SECRET`。claims：`sub` = `Operator.id`，`email`。

**Nest 接口（挂在 `/api/v1/admin/auth`）：**

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/login` | 邮箱 + 密码 → access + refresh |
| POST | `/refresh` | 轮换 refresh；已用过的 refresh 被重放 → 撤销该运营的整个家族 |
| POST | `/logout` | 撤销当前 refresh |
| POST | `/setup` | 用一次性令牌设置密码，状态 `INVITED → ACTIVE` |

**添加与停用运营（CLI，沿用现有的 dry-run、`--operator`、`--reason` 约定）：**

- `operator:add <邮箱>`：创建 `INVITED` 的运营，打印一次性设置链接，明文只显示这一次。
- `operator:reset <邮箱>`：作废旧设置令牌，签发新的（忘记密码走这条）。
- `operator:disable <邮箱>`：状态置 `DISABLED`，同时撤销其全部 refresh。
- 第一个运营由 Owen 用 CLI 创建，不存在"开放注册"。

**守卫：** 新增 `OperatorAuthGuard`，换掉第 1 块的 `AdminApiTokenGuard`。每次请求验 JWT（audience、过期），再查库确认 `Operator.status = ACTIVE`，所以停用立刻生效。通过后把 `{ id, email }` 放到 `request.operator`。`ADMIN_API_TOKEN` 随之从 `EnvSchema` 移除，只留一种鉴权方式。

**防暴力破解（不用 `@nestjs/throttler`）：** Vercel 是 serverless，内存里的限流器在多个实例之间不共享，形同虚设。改用数据库计数：连续 5 次登录失败 → `lockedUntil` = 现在 + 15 分钟，锁定期内即使密码正确也拒绝（返回的同样是"凭证无效"）；成功登录清零。登录失败一律返回统一的"凭证无效"，不区分"没有这个邮箱"和"密码错"（沿用 `AuthService` 的 `DENIED`）。邮箱不存在时同样做一次密码哈希比较，避免靠响应时间枚举邮箱。代价：知道运营邮箱的人可以反复触发锁定使其暂时登不进，对少数内部运营可接受，并且锁定会写审计事件。

**新增环境变量：** `OPERATOR_SETUP_TTL_HOURS`（默认 24）、`OPERATOR_REFRESH_TTL_DAYS`（默认 7）。access 令牌有效期沿用 `ACCESS_TOKEN_TTL`。

## 5. 区分运营改动与学员改动

靠已有的 `AuditEvent.actorType`（`USER | OPERATOR | SYSTEM`），不新建机制。本节规定怎么贯彻：

1. **运营的所有写操作一律记 `OPERATOR`，`actorId` 统一用运营邮箱。** 来源有三条：管理后台、admin API、CLI。CLI 现有的 `--operator <邮箱>` 就是邮箱，管理后台取登录令牌里的 `email`，所以三条来源的 `actorId` 口径一致，不需要再 join `Operator` 表，也兼容已有的历史记录。第 1 块计划里自报的 `X-Operator` 请求头因此取消，改用登录身份。
2. **学员自己的操作保持记 `USER`，`actorId` 是学员 id**（现有的 `enrollment.enroll`、`enrollment.restart` 就是这样）。不为学员新增审计埋点。
3. **同一个对象，两种来源能分开。** 例如报名：学员自己报名是 `enrollment.enroll`（`USER`），运营代报名是 `admin.enrollUser`（`OPERATOR`）；配额只有 `admin.grantQuota`（`OPERATOR`）。动作名前缀 `admin.` 也一并保持。
4. **运营登录相关事件也记审计：** `admin.auth.login`（成功和失败，失败 `success=false`）、`admin.auth.logout`、`admin.auth.setup`、`admin.auth.locked`。

**审计页（`GET /api/v1/admin/audit`）：** 游标分页（按 `createdAt` 倒序，`id` 兜底），`limit` 默认 50、最大 100；可按 `actorType`、`actor`（邮箱）、`action`、`targetType` 筛选。每条返回 `actor: { type, id, label }`：`OPERATOR` 的 `label` 就是邮箱；`USER` 的 `label` 由本页涉及的学员 id 批量查出邮箱（查不到则为 `null`）；`SYSTEM` 没有。界面用不同颜色的标签区分"运营 / 学员 / 系统"，默认视图是全部，一键切到"只看运营"或"只看学员"。

## 6. Next 管理后台（`apps/admin`）

**路由：**

| 路径 | 内容 |
|---|---|
| `/login`、`/setup` | 登录；用一次性令牌设置密码 |
| `/courses` | 课程列表：状态、已发版版本、有无草稿、课时数、在学人数；**"新建课程"按钮**：输入 slug 和标题 → `POST /admin/courses` → 跳到课程页 |
| `/courses/[slug]` | 版本状态、创建/丢弃草稿、课程元信息、模块与课时树、发版 |
| `/courses/[slug]/lessons/[contentId]` | 三栏编辑器：结构树 / 块卡片列表 + 属性面板 + 预览 iframe / 本节测评题 |
| `/invitations` | 邀请学员；学员列表与状态 |
| `/quotas` | 发配额；配额发放记录 |
| `/audit` | 审计记录（第 5 节） |

**数据流：** 读数据用 Server Component，写数据用 Server Action，都由 Next 服务端调用 `apps/api`，浏览器里的 JS 从不直接调 Nest，所以没有 CORS，令牌也不进浏览器。`apps/admin` 里不引入数据库客户端。

**会话：** 两个 cookie——access 和 refresh，均 `HttpOnly`、`Secure`、`SameSite=Strict`。Server Component 里不能写 cookie，所以刷新放在 `proxy.ts`（Next 16 里 `middleware` 的新名字）：access 将过期且有 refresh 时，调用 `/admin/auth/refresh`，同时更新往下游传的请求和返回的响应里的 cookie；没有会话则重定向到 `/login`。这只是体验，真正的鉴权在 Nest 的 `OperatorAuthGuard`。变更类请求只走 Server Action（自带来源校验）加 `SameSite=Strict`，不另做 Route Handler。

**编辑器：** 客户端组件，课时是一串块，不是一大段文字。
- **块卡片列表：** 每块一张卡，带 Edit / Duplicate / Delete / 上移 / 下移；"Add Content"选择器列出 13 种块（名称与默认属性来自 `packages/lesson-blocks` 的 `BLOCK_REGISTRY`）。
- **属性面板：** 选中块后，表单由该块的 schema 生成（`z.toJSONSchema`）；`image` 的 `assetId` 不让运营手填，用"上传图片 / 从本课程素材中选择"（调 `POST /admin/courses/:slug/assets`，课程封面、欢迎页概览图同理）。
- **自动保存：** 修改后防抖提交 `PATCH /draft/lessons/:contentId`，显示"保存中 / 已保存 / 保存失败（重试）"；失败时保留本地改动并阻止离开页面。块有错误也照存，响应里的 `problems`（错误 / 警告）显示在对应卡片上。撤销 / 重做（本地历史栈，至少 50 步）。
- **预览：** 右侧 iframe 指向 client 的 `/preview/lesson`，加载完成（收到 `lesson-preview-ready`）后和每次内容变化都 `postMessage` 当前课时块、本课程素材地址和 `problems`；只向配置的 client 域名发送。
- 发版弹窗调用发版接口，把校验失败的完整问题列表原样展示（来自第 1 块的 422）；成功提示"N 名在学学员会立刻看到新版"。

**邀请、配额页：** 写操作表单带必填的"原因"（`reason`），沿用 `AdminService` 现有签名与审计。邀请成功后明文邀请令牌只在当次响应里显示一次，页面提供复制按钮，刷新后不再可见。

**界面规范：** Tailwind + shadcn/ui；按路由和功能分文件夹（课程、编辑器、邀请、配额、审计、会话），每个文件 200–400 行，不超过 800。

## 7. Nest 接口增量（在第 1 块的接口之上）

读（第 1 块没有，界面需要）：

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/admin/courses` | 课程列表：slug、标题、`published`、最大已发版版本、是否有草稿、课时数、在学人数（`active` 报名数） |
| GET | `/admin/courses/:slug/draft` | 整棵草稿：模块、课时（含 `body`、测评题）、`meta`、欢迎页 |
| GET | `/admin/users` | 学员列表：邮箱、状态、创建时间，支持邮箱关键字和游标分页 |
| GET | `/admin/quotas` | 配额发放记录：学员邮箱、分钟数、过期时间、时间，游标分页，可按学员邮箱筛选 |
| GET | `/admin/audit` | 见第 5 节 |

写：

| 方法 | 路径 | 调用 |
|---|---|---|
| POST | `/admin/invitations` | `AdminService.inviteUser(email, operator, reason)`；响应含一次性明文令牌 |
| POST | `/admin/quotas` | `AdminService.grantQuota(email, minutes, operator, reason)` |

所有写接口的 `operator` 取自 `request.operator.email`。接口请求与响应的 zod schema 放 `packages/admin-contract`。

## 8. 对第 1 块的影响

- **路径：** 第 1 块计划里所有 `src/…`、`prisma/…`、`test/…` 变成 `apps/api/…`，任务顺序与内容不变（机械改写）。
- **鉴权：** 第 1 块先用 `ADMIN_API_TOKEN` 上线；本块落地时把守卫换成 `OperatorAuthGuard`，移除 `ADMIN_API_TOKEN` 与 `X-Operator`，对应的测试同步改。两个守卫不同时存在。
- **审计：** 第 1 块的 `admin.draft.*` 与 `admin.publishCourse` 事件，`actorId` 从自报的 `X-Operator` 改为登录身份的邮箱。

## 9. 出错处理与安全

- 未登录、令牌无效、运营已停用、账号被锁定 → 一律 401，文案统一。锁定不单独返回 429：否则攻击者能靠"哪个邮箱会被锁"枚举出有效邮箱（不存在的邮箱没有计数行，永远锁不上）。被锁的运营靠 `admin.auth.locked` 审计事件和另一位运营/CLI 得知原因，15 分钟后自动解锁。
- 设置令牌过期、已用过或不存在 → 400，统一文案，不透露是哪种。
- Server Action 遇到 Nest 返回的 401：尝试一次刷新，仍失败则清 cookie 并重定向 `/login`。
- 422（发版校验失败）、404（草稿不存在）、409（`contentId` 重名）：界面直接展示 Nest 返回的信息，不吞掉。
- 不记录密码、令牌明文到日志；设置链接只在 CLI 输出里出现一次。
- 不在 `apps/admin` 里引用 `JWT_SECRET`、`DATABASE_URL`；admin 只需要 Nest 的地址（`API_BASE_URL`）。

## 10. 测试

先写测试，覆盖率不低于 80%。

- **api（jest，沿用现有）：** 登录成功/失败/统一错误文案；5 次失败锁定与解锁、锁定期内正确密码也拒绝；refresh 轮换与重放撤销整个家族；停用后旧令牌立即 401；学员令牌调 admin 接口 401（audience 隔离）；`operator:add / reset / disable` 的 dry-run 与 `--execute`；审计分页、筛选与 `actor.label` 解析；每个写接口记的是 `OPERATOR` + 邮箱。
- **admin（vitest + Testing Library）：** 编辑器的未保存提示、发版弹窗展示问题列表、`proxy.ts` 的重定向与刷新、Server Action 的 401 重试。
- **端到端（Playwright）：** 登录 → 创建草稿 → 改一节正文 → 预览 → 发版 → 审计页能看到这次发版且标为"运营"。
- **块编辑器：** 增删复制排序、自动保存状态机（保存中/已保存/失败重试）、撤销重做、问题提示显示在对应卡片、图片属性的上传与选择；预览消息只发往配置的 client 域名、`ready` 之前不发。
- **契约：** admin 用 `packages/lesson-blocks` 的 `BLOCK_REGISTRY` 生成表单，注册表与 schema 的测试在该包里（不再有 admin 自己的渲染器和对应样例）。

## 11. 实施顺序与拆分

一份 spec，三份 plan，另加前置的搬迁：

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 0 | monorepo 搬迁。**`apps/api` 与 workspaces 骨架由课时块计划的任务 0 完成**（含下述 Vercel 关卡）；`apps/admin` 空壳、`packages/admin-contract`、第二个 Vercel 项目由第 4 块计划建立。**关卡：** 改 Vercel 现有项目的 Root Directory 之前，先在预览环境验证一次完整部署，Owen 确认后再改线上 | 无 |
| 1 | 第 1 块计划改路径后执行 | 步骤 0 |
| 2 (4a) | `Operator` 相关迁移（Owen 看对比页）、登录/刷新/设置接口、`OperatorAuthGuard` 替换令牌守卫、`operator:*` CLI、admin 骨架 + 登录页 + `proxy.ts` | 步骤 1 |
| 3 (4c) | 邀请、配额、审计三个页面和第 7 节对应接口 | 步骤 2 |
| 4 (4b) | 课程列表（含新建课程）、块编辑器（含素材上传）、预览、发版 | 步骤 2、课时块 spec 的 `packages/lesson-blocks` 与 client 渲染器/预览页已上线 |

## 12. 已知限制

- 通过 Neon MCP 直接改草稿的操作没有审计记录（第 1 块已记），所以这类改动仍然分不清是谁做的；它只能由有数据库权限的人执行。
- 管理后台和 admin API 暴露在公网，只有账号密码这一层防护；锁定机制可被用来短暂锁住某个运营。将来如需更强防护（多因素、IP 白名单），另开 spec。
- 预览依赖 client 的预览页在线：client 不可用时编辑器仍可编辑与保存，预览区显示"预览不可用"。预览页与学员端是同一份渲染代码，但预览是后台模式（非法块显示红色占位），不是逐像素等同。
- `QuotaLedger` 没有消费方，配额页只展示发放记录，不展示余额。

## 13. 2026-10-01 修订汇总

对应课时块 spec 第 13 节：

- 新建课程进入 v1（课程列表按钮 + `POST /admin/courses`）；导入 `course.json` 界面仍待 Owen 确认。
- 编辑器：显式保存按钮 → 自动保存；`:::step` 块语法 → 块卡片 + 属性面板；admin 自己的渲染器 → iframe 嵌 client 预览页（第 2 节"预览渲染"、第 6 节"编辑器"、第 10 节测试、第 12 节已知限制已改）。
- 素材：图片上传 / 选择在块属性、课程封面、欢迎页概览图里使用。
- 依赖顺序：lesson-blocks 包 → client 渲染器与预览页 → 4b；4a、4c 与它们无依赖，可并行。
- 新增配置：`apps/admin` 需要 `NEXT_PUBLIC_CLIENT_ORIGIN`；client 需要 `NEXT_PUBLIC_ADMIN_ORIGIN`（两边互为白名单）。
