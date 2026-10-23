# AIVirTeach — Control Plane (aivirteach-server)

NestJS 模块化单体，AIVirTeach 三个代码仓库之一（另外两个：`aivirteach-client` 桌面端、`aivirteach-labs` KubeVirt Runtime）。**这是唯一连数据库、唯一签发 token、唯一调用 Labs 的服务**——client 和 Labs 都不直连数据库。

## 生产环境

| | |
|---|---|
| API base URL | `https://aivirteach-server.vercel.app/api/v1` |
| Swagger UI | `https://aivirteach-server.vercel.app/docs` |
| OpenAPI JSON | `https://aivirteach-server.vercel.app/docs-json` |
| 健康检查 | `GET /api/v1/health` → `{ status: 'ok', database: 'up' \| 'down' }` |
| 部署 | Vercel（NestJS 走 serverless function；`apps/api/vercel.json` 配置每日 workspace 清理重试） |
| 数据库 | Neon Postgres（`us-east-1`），通过 Vercel Marketplace 集成自动注入 `DATABASE_URL` |

已经用运营 CLI 种了一个联调账号：`client-integration@aivirteach.dev`（已开 `demo-course`、发了 120 分钟额度），可以直接登录联调；密码不写进仓库，找 @joelsia97 要。除此之外表里没有其他数据，没有 seed 脚本——需要更多测试数据时照下方"造第一个账号"的步骤自己加。

## 技术栈

- NestJS 11 + Express，全局前缀 `api/v1`
- Prisma 6 + Postgres（本地走 docker-compose，生产走 Neon）
- 鉴权：自签 JWT（`jose`，access + refresh 双 token），**不接第三方 IdP**
- 校验：Zod，`ZodValidationPipe` 统一在 controller 层拦
- 运营侧：`nest-commander` 写的 CLI，不是 admin 后台网页

## 仓库结构

```text
apps/api/              NestJS API、Prisma schema/migrations、CLI 和测试
apps/admin/            运营后台（Next.js，只经 HTTP 调 API，不碰数据库）
packages/*/            可复用的工作区包（lesson-blocks、admin-contract）
docker-compose.yml      本地 Postgres
docs/                  设计与开发文档
```

仓库根使用 npm workspaces；依赖安装和 `build`、`test`、`test:e2e`、`test:cov`、`lint` 从根目录运行。API 自有脚本（例如数据库迁移和 CLI）在 `apps/api` 工作区运行。

## 本地开发

```bash
npm install
cp apps/api/.env.example apps/api/.env  # 至少要填 JWT_SECRET，见下方生成方式
npm run db:up              # 起本地 Postgres（docker-compose，端口 55432）
npm run db:migrate -w api
npm run start:dev -w api   # http://localhost:4000/docs
```

环境文件放在 `apps/api/.env`（以及可选的 `apps/api/.env.local`），Prisma 和应用都以 API 工作区为基准读取它们。

Vercel 的 Root Directory 需要设为 `apps/api`，并开启 **Include source files outside of the Root Directory in the Build Step**，以便构建时也能访问根目录下的 `packages/*`。线上 Vercel 项目设置应在迁移预览部署通过后再调整。

课程 restart 会递增 `Enrollment.generation`，旧代次的课时完成和聊天写入会在事务内拒绝。每次 Labs VM 创建使用独立的 `Workspace.provisionGeneration` 和 VM ID，旧请求不能覆盖新一轮创建。发起创建前会写入 `WorkspaceProvision` 清理记录；VM 成功绑定当前 workspace 时才在同一事务中移除。晚到的 VM 删除失败后仍可由扫描重试；创建结果未知时，即使一次查询未发现 VM，也会保留清理记录并持续对账。restart 还会先保存 `Workspace.status=RESETTING`，再删除 Labs VM。若旧 VM 仍在创建（包括重建时已有旧 `labId`），清理任务会等待最多 210 秒的创建请求窗口，避免过早确认“VM 不存在”；此时或 Labs 暂时不可用时，restart 响应的 `workspaceResetPending` 为 `true`。失败的任务会安排下一次重试，避免挡住后面的任务。后续请求会触发扫描，`apps/api/vercel.json` 还配置了每天一次的兜底扫描。部署前需先应用 `20261010000000_enrollment_generation_and_workspace_retry` 迁移，并在 API 项目的 Production 环境配置至少 16 字符的 `CRON_SECRET`；Vercel 会在定时请求的 `Authorization: Bearer` 中发送它。维护端点是 `GET /api/v1/internal/workspace-maintenance`，未配置密钥或鉴权失败时返回 401。

若 Agent 回复在 restart 后才到达，回复不会写回已清空的聊天记录；已测量的 token 消耗会按 Agent 请求 ID 幂等记入 `QuotaLedger`，因此重启不会退回已经消耗的额度。

生成本地 `JWT_SECRET`：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

## 环境变量

由 `apps/api/src/config/env.ts` 用 Zod 在启动时强校验，缺一个直接崩，不会带着错配置跑起来。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | Postgres 连接串 |
| `JWT_SECRET` | 是 | ≥32 字符，生产环境从 Vercel env 注入，绝不提交进仓库 |
| `ACCESS_TOKEN_TTL` | 否，默认 `15m` | jose 简单格式：数字+单位 |
| `REFRESH_TOKEN_TTL_DAYS` | 否，默认 `30` | |
| `INVITATION_TTL_DAYS` | 否，默认 `7` | |
| `OPERATOR_SESSION_TTL` | 否，默认 `8h` | 运营登录令牌的有效期（jose 简单格式）。没有 refresh，到期重新登录。旧的 `ADMIN_API_TOKEN` 已取消；**生产里的这个变量先别删**——4a 之前的版本启动时要求它存在，回滚到旧版本会因为缺它整个 API（含学员接口）起不来，等 4a 在生产稳定运行后再删 |
| `PORT` | 否，默认 `4000` | Vercel 上由平台接管，本地开发才用得到 |
| `CORS_ORIGINS` | 否，默认 `tauri://localhost` | 逗号分隔白名单；client 桌面端（Tauri v2 webview）的源是 `tauri://localhost`，本地网页调试再加 `http://localhost:3001` |
| `TOKEN_QUOTA_ENFORCED` | 否，默认 `false` | 是否强制 AI 助教的 token 额度。关闭时只记录用量、不拦截；只认 `true` / `false`。上线顺序见下方「Token 用量与额度」 |
| `TOKEN_WEIGHT_CACHE_HIT` / `TOKEN_WEIGHT_INPUT_MISS` / `TOKEN_WEIGHT_OUTPUT` | 否，默认 `0.02` / `1` / `4` | 三类 token 折算成额度的权重（以未命中输入为 1）。默认值取自 DeepSeek flash 的价格比例，换模型或价格变了要同步调整 |

生产环境变量用 `vercel env ls` / `vercel env add` 管理，不要手改 Vercel 控制台之外的地方。

## 鉴权模型：邀请制，没有自助注册

没有 `POST /auth/register`。流程是：

1. 运营用 CLI 的 `invite` 命令给一个邮箱发邀请，拿到一次性 `invitationToken`
2. 用户拿这个 token 调 `POST /auth/invitations/accept`（带 token + 自己设的密码）换到 access/refresh token 对，账号这时候才真正建出来
3. 之后正常 `POST /auth/login`

| 接口 | 用途 |
|---|---|
| `POST /auth/invitations/accept` | 用邀请 token + 密码激活账号 |
| `POST /auth/login` | 邮箱 + 密码登录 |
| `POST /auth/refresh` | 用 refresh token 换新的 access token |
| `POST /auth/logout` | 吊销 refresh token |
| `GET /auth/me` | 需要 `Authorization: Bearer <access_token>` |

## 运营 CLI 是什么

封测期没有 admin 后台网页——发邀请、建课程、开课、发额度这些运营操作量很小，做一整套带鉴权的管理网页不划算，所以做成了一个命令行工具（`nest-commander`），入口是 `npm run cli -w api -- <args>`。谁要执行，就在自己电脑上（或有权限访问生产库的机器上）跑这个命令，天然就是"内部人员本机操作"的权限模型，不用另外造一套 admin 登录态。

| 命令 | 参数 | 作用 |
|---|---|---|
| `invite <email>` | | 邀请一个用户，生成一次性 `invitationToken` |
| `course:create <contentDir>` | `--image-digest`（可选） | 从课程内容目录（含 `course.json`）摄取新建课程，同时建第一个未发布的版本 |
| `course:publish <slug>` | | 发布课程的最新版本 |
| `enroll <email> <courseSlug>` | | 给用户开课 |
| `quota:grant <email> <minutes>` | | 给用户发运行额度（分钟） |
| `operator:add <email>` | | 新增运营账号，随机密码只在输出里出现一次 |
| `operator:reset <email>` | | 重置运营密码（旧令牌立即失效），新密码只在输出里出现一次 |
| `operator:disable <email>` | | 停用运营账号（仍在有效期内的令牌下一次请求即 401） |
| `quota:grant-tokens <email> <tokens>` | | 给用户发 AI 助教 token 额度（加权后的额度单位，见下方「Token 用量与额度」） |

所有命令都要求 `--operator`（谁在操作）和 `--reason`（为什么），并且**默认 dry-run**——不加 `--execute` 只打印将要发生的变更、不落库。这两点不是可选的：目的是让审计日志（`AuditEvent` 表）永远能查到"谁、为什么、改了什么"，而不是留一堆无主的写操作。

## 课时块 / admin API

课时正文只使用 `CourseLesson.content`，格式为 `{schemaVersion:1, blocks:[…]}`，支持 13 种块，最多 300 块、256 KB。课时 API 返回 `blocks` 与 `assets`，不提供课程 Markdown 回退。Markdown 文件仍可作为摄取源，经转换后写入 content。聊天 Markdown 渲染不受影响。

`/api/v1/admin/*` 供运营后台用，每个请求要带：

- `Authorization: Bearer <运营令牌>`：先 `POST /api/v1/admin/auth/login`（`{email, password}`）换取，有效期见 `OPERATOR_SESSION_TTL`；学员令牌调不通，运营令牌也调不通学员接口（JWT audience 不同）

审计日志里的操作者就是登录的运营邮箱（`actorType = OPERATOR`），不再接受自报的 `X-Operator`。5 次登录失败锁 15 分钟；停用或重置密码后旧令牌立即失效。运营账号写在 `Operator` 表里，用 `operator:add` 创建，没有邀请流程。Swagger 页要先登录拿令牌再填进 Authorize。

草稿写接口（`PATCH/PUT/DELETE /admin/courses/:slug/draft*`、模块和课时的 `POST`）只返回不含课时正文的摘要，完整草稿用 `GET /admin/courses/:slug/draft`，单课预览用 `GET /admin/courses/:slug/draft/lessons/:contentId`。发版（`POST /admin/courses/:slug/publish`）会在事务内锁住草稿并重新校验，校验未通过返回 422 和 `problems`。

### 内容迁移 B 的交付边界

本次代码移除 `CourseLesson.body` 和课程 API 的 `markdown`。旧的 `course:backfill-content-model` 命令已经退役，不要再用历史迁移 A 的步骤修改进度或回填正文。

数据库删列由 Owen 使用 Neon MCP 单独执行，本仓库此次没有新增迁移文件，也没有执行生产操作。先核验全部课程版本内容完整，再部署匹配的 API、admin、client，最后删列；不要在旧 API/admin 仍运行时删除 body。详见 [内容迁移 B 数据库交接与验证](docs/verification/2026-10-24-content-only.md)。

## Token 用量与额度

AI 助教每次回复消耗的 token 由 Labs 从 DeepSeek 的 `usage` 里取出，按计费口径分三类（缓存命中输入 / 未命中输入 / 输出），记在 `Conversation` 的 `inputCacheHitTokens` / `inputCacheMissTokens` / `outputTokens` 三列上；Labs 没返回 usage 的回复三列留空（未计量，不是 0）。

**额度**是一个按用户的余额：`余额 = SUM(QuotaLedger.tokensDelta) - 加权消耗`，加权消耗 = `ceil(命中 × 0.02 + 未命中 × 1 + 输出 × 4)`（权重见环境变量）。余额 ≤ 0 时，聊天的两条 POST 路由（含流式）在 handler 之前返回 HTTP 429 `TOKEN_QUOTA_EXHAUSTED`，不写任何 Conversation。额度检查本身失败时放行（fail-open），只记错误日志。token 额度不支持过期。

**运营报表**：`GET /api/v1/admin/token-usage?groupBy=user|course|day&from=…&to=…`（Bearer 运营令牌；区间左闭右开，默认最近 7 天，按天分组用 UTC 日期）。每行带三类原始 token、加权消耗、`meteredTurns` 和 `unmeteredTurns`（真实 Agent 回复里没计上量的条数，非 0 说明数字被低估）；按用户分组时还有 `grantedTokens`（累计发放）、`lifetimeConsumption`（**全期**加权消耗）和 `balance`（`grantedTokens - lifetimeConsumption`，和上面 429 判定同一口径）。注意 `weightedConsumption` 只统计报表时间窗口，所以不等于 `grantedTokens - balance`。

**已知边界（都是少计，不会多扣学生）：**

- 只有成功落库的 AI 助教回复带 usage。Labs 报错走兜底话术、流式中途出错或被截断、客户端中途断开时，上游可能已经花掉 token，但这些调用没有记录，`unmeteredTurns` 也看不出来。Labs 的 usage 只在最终 `result` 事件里上报，要补需要改 SSE 协议。
- 额度检查在 Labs 返回之前，扣减在返回之后，所以同一用户并发发起的多条消息会各自通过检查，超额量没有上限（软上限）。
- 课程 restart 会清空对话，所以 restart 的事务里会先把被清空对话的加权消耗写成一条负的 `QuotaLedger`（`tokensDelta < 0`）。余额不变，但该用户的 `grantedTokens` 会相应变小、`lifetimeConsumption` 也不再包含这部分，两者之差（`balance`）仍然正确。
- Labs 返回的 usage 格式非法时 server 会丢弃该条用量并打 warn 日志（`Labs 返回的 usage 格式非法`）；上线后看到这条日志说明计量在静默丢数据。

### 上线顺序

1. 先部署 server 和迁移：`usage` 在响应里是可选的，Labs 还没改时一切照旧。
2. 再部署 Labs，开始返回 usage，server 开始记录。
3. 观察一段时间报表（看 `unmeteredTurns`），用 `quota:grant-tokens` 给用户发额度。**消耗从第一条被计量的回复开始累计，不是从发放额度开始**：观察期里已经用掉的量会从新发的额度里扣。发放前先看报表里该用户的 `lifetimeConsumption`，发放量要覆盖它再加上想给的新额度，否则开启强制后刚发完额度的用户可能立刻被 429。
4. 最后把 `TOKEN_QUOTA_ENFORCED` 设为 `true`。**先开强制再发额度，所有没有额度的用户会立刻被 429。**

## 造第一个账号（联调用）

```bash
# 本地跑（连的是 .env 里配置的库）
npm run cli -w api -- invite someone@example.com -o "你的邮箱" -r "联调测试账号" --execute
# 拿到返回的 invitationToken，再调 POST /auth/invitations/accept 激活

npm run cli -w api -- course:create /path/to/course-content-dir -o "你的邮箱" -r "联调用课程" --execute
# course-content-dir 下要有 course.json（定义课程/模块/课时结构，见 apps/api/src/courses/course-content.schemas.ts）
npm run cli -w api -- course:publish <slug> -o "你的邮箱" -r "发布" --execute
npm run cli -w api -- enroll someone@example.com <slug> -o "你的邮箱" -r "开课" --execute
npm run cli -w api -- quota:grant someone@example.com 60 -o "你的邮箱" -r "发额度" --execute
```

要对生产库操作，先 `vercel env pull .env.production --environment production --yes`，`source` 进去再跑同样的命令，跑完把临时文件删掉。

## 运营后台上线顺序（4a）

顺序不能换：新代码一部署，旧的 `ADMIN_API_TOKEN` 调用立即失效，所以**先建好运营账号，再部署 api**。

1. **迁移**：对生产库应用 `20261005000000_operator_accounts`（新增 `Operator` 表、`OperatorStatus` 枚举、`AuditEvent(createdAt)` 索引；纯新增，不动旧数据）。生产库走 Neon MCP，在事务内执行 SQL 并补写 `_prisma_migrations` 行（见「生产环境」）。
2. **创建第一个运营**：CLI 在本机直接连库，不需要 api 已部署。用显式生产 `DATABASE_URL` 执行 `npm run cli -w api -- operator:add <email> -o <你的邮箱> -r "首个运营" --execute`，记下输出的密码（只出现一次）。`add` / `reset` 写入的 `passwordChangedAt` 取数据库时间，不依赖这台机器的时钟。
3. **部署 api**（手动 `vercel deploy --prod`）。此刻 `ADMIN_API_TOKEN` 失效，需要时改用运营令牌。
4. **部署 `apps/admin`**：第二个 Vercel 项目，Root Directory 为 `apps/admin`，环境变量只需 `API_BASE_URL`（api 的公网地址，含 `/api/v1`）。**不要**给它配 `JWT_SECRET` 或 `DATABASE_URL`。
5. **给登录接口加限流**：登录是匿名接口，每次请求（包括不存在的邮箱）都会做一次密码哈希并写一条审计。应用层没有限流（serverless 下内存限流无效），建议在 Vercel Firewall 里给 `/api/v1/admin/auth/login` 加一条速率限制规则。

改 Vercel 现有项目的 Root Directory 之前，先在预览环境验证一次完整部署。

## 测试

```bash
npm test            # 单元测试
npm run test:e2e    # e2e
npm run test:cov    # 覆盖率
```

Jest 需要 `--experimental-vm-modules`（已经写进 npm scripts 里了）——因为鉴权模块动态 `import()` 了纯 ESM 的 `jose`，这是 Vercel serverless 运行时兼容 `jose` 的必要写法，不是历史遗留。

## 已知限制

- 除了上面那个联调种子账号，库里没有其他数据，没有 seed 脚本
- `main` 与 GitHub `origin/main` 历史有分叉，还没有开 PR 合并
- CI 还没接（对应 Linear SRV-001）
- `ACCESS_TOKEN_TTL` / `CORS_ORIGINS` / `PORT` / `INVITATION_TTL_DAYS` / `REFRESH_TOKEN_TTL_DAYS` 这几个纯配置项在 Vercel 上被误标成了 sensitive，导致 `vercel env pull` 拉不出真实值（生产运行不受影响，只是本地没法照抄这几个值）；要清理的话去 Vercel 项目设置里把它们删掉重加成非 sensitive

## 课程编辑后台（4b）

运营登录后进入 `/courses`，可以新建课程、编辑模块和课时、编写内容块、上传图片、创建和修改测评，并发布草稿。课时自动保存失败或登录过期时保留本地内容；保存成功后才能离开。元信息与测评使用显式保存。

预览使用 client 的 `/preview/lesson`。admin 配置 `NEXT_PUBLIC_CLIENT_ORIGIN`，client 配置对应的 `NEXT_PUBLIC_ADMIN_ORIGIN`，两者均使用不带路径的 origin。client 的来源配置在构建时生效。素材上传仍需要 API 的 Vercel Blob 配置。

同课时多人同时编辑仍为后写覆盖。发布会更新课程 API；V2 的静态 HTML 接线尚未纳入本阶段。完整验证步骤与未完成验收见 [课程后台 A 验证记录](docs/verification/admin-course-editor.md)。
