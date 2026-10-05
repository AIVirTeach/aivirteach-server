# AIVirTeach — Control Plane (aivirteach-server)

NestJS 模块化单体，AIVirTeach 三个代码仓库之一（另外两个：`aivirteach-client` 桌面端、`aivirteach-labs` KubeVirt Runtime）。**这是唯一连数据库、唯一签发 token、唯一调用 Labs 的服务**——client 和 Labs 都不直连数据库。

## 生产环境

| | |
|---|---|
| API base URL | `https://aivirteach-server.vercel.app/api/v1` |
| Swagger UI | `https://aivirteach-server.vercel.app/docs` |
| OpenAPI JSON | `https://aivirteach-server.vercel.app/docs-json` |
| 健康检查 | `GET /api/v1/health` → `{ status: 'ok', database: 'up' \| 'down' }` |
| 部署 | Vercel（zero-config，NestJS 走 serverless function，无需 `vercel.json`） |
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
packages/*/            可复用的工作区包
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
| `ADMIN_API_TOKEN` | 是 | ≥32 字符，`/admin/*` 接口的 Bearer 令牌（没有默认值，漏配整个 API 启动即崩，学员接口也会一起挂）。不要和 `JWT_SECRET` 共用 |
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
| `course:backfill-content-model` | `--execute`（默认 dry-run） | 回填课时 `body`、课时块 `content` 和学员进度的 `currentLessonContentId`（迁移 A 之后跑，见下方"课时块上线顺序"） |
| `enroll <email> <courseSlug>` | | 给用户开课 |
| `quota:grant <email> <minutes>` | | 给用户发运行额度（分钟） |
| `quota:grant-tokens <email> <tokens>` | | 给用户发 AI 助教 token 额度（加权后的额度单位，见下方「Token 用量与额度」） |

所有命令都要求 `--operator`（谁在操作）和 `--reason`（为什么），并且**默认 dry-run**——不加 `--execute` 只打印将要发生的变更、不落库。这两点不是可选的：目的是让审计日志（`AuditEvent` 表）永远能查到"谁、为什么、改了什么"，而不是留一堆无主的写操作。

## 课时块 / admin API

课时正文 `CourseLesson.content` 是课时块 JSON（`{schemaVersion:1, blocks:[…]}`，13 种块，最多 300 块、256 KB），由 client 渲染；`body`（Markdown）是弃用的兜底字段，管理员新建或编辑的课时只写 `content`，老客户端读到的 `markdown` 可能为空或过期。

`/api/v1/admin/*` 供运营后台用，每个请求要带：

- `Authorization: Bearer <ADMIN_API_TOKEN>`
- `X-Operator: <操作者邮箱>`（写入审计日志；目前是自报身份，block 4 的 `OperatorAuthGuard` 会替换）

草稿写接口（`PATCH/PUT/DELETE /admin/courses/:slug/draft*`、模块和课时的 `POST`）只返回不含课时正文的摘要，完整草稿用 `GET /admin/courses/:slug/draft`，单课预览用 `GET /admin/courses/:slug/draft/lessons/:contentId`。发版（`POST /admin/courses/:slug/publish`）会在事务内锁住草稿并重新校验，校验未通过返回 422 和 `problems`。

### 课时块上线顺序

学员进度现在只读 `Progress.currentLessonContentId`。**代码比迁移 A 和回填先上线，所有已有学员会显示未开始（0%），下一次完成课时还会覆盖进度指针**，所以必须按这个顺序：

1. 在 Vercel 配好 `ADMIN_API_TOKEN`，并核对项目的 Root Directory / "include files outside root"（仓库是 npm workspaces monorepo）。
2. 预检：同一课程不能有多个未发布版本，否则迁移 A 的部分唯一索引会失败：
   ```sql
   SELECT "courseId", count(*) FROM "CourseVersion" WHERE "publishedAt" IS NULL GROUP BY 1 HAVING count(*) > 1;
   ```
3. `npx prisma migrate deploy`（迁移 A，只加列和索引）。
4. 回填 dry-run，随时可以先跑、先审：`unresolved` / `skipped` / `pendingBody` 要为空或逐条确认。
   ```bash
   npm run cli -w api -- course:backfill-content-model -o "你的邮箱" -r "迁移 A 回填"
   ```
5. 真正回填（`--execute`）要**紧贴着部署**，选低峰期，执行完立刻部署：
   ```bash
   npm run cli -w api -- course:backfill-content-model -o "你的邮箱" -r "迁移 A 回填" --execute
   ```
6. 部署代码，观察学员读课和进度。**部署之后不要再跑回填。**
7. 迁移 B（不可逆，删旧列）单独执行，必须有明确的批准，不随上面几步一起跑。

**已知的上线窗口：** 旧代码一直在线到步骤 6，它只写旧字段 `currentLessonId`；回填只补 `currentLessonContentId` 为空的行，不会修正已经填过、之后又被旧代码推进的进度。所以步骤 5 执行之后、部署完成之前这几分钟里仍在推进课时的学员，部署后会回到回填时的位置；在这段时间里新开始学习的学员会显示未开始。其余学员不受影响。窗口越短越好，所以要求紧贴部署和低峰期。要做到零损失，需要新代码在迁移 B 之前同时写两个字段，这不在本 PR 范围内。

代码上线后**不能直接回滚**：新代码不再写旧的 `currentLessonId`，回滚到旧版本会丢掉上线后产生的学员进度。

## Token 用量与额度

AI 助教每次回复消耗的 token 由 Labs 从 DeepSeek 的 `usage` 里取出，按计费口径分三类（缓存命中输入 / 未命中输入 / 输出），记在 `Conversation` 的 `inputCacheHitTokens` / `inputCacheMissTokens` / `outputTokens` 三列上；Labs 没返回 usage 的回复三列留空（未计量，不是 0）。

**额度**是一个按用户的余额：`余额 = SUM(QuotaLedger.tokensDelta) - 加权消耗`，加权消耗 = `ceil(命中 × 0.02 + 未命中 × 1 + 输出 × 4)`（权重见环境变量）。余额 ≤ 0 时，聊天的两条 POST 路由（含流式）在 handler 之前返回 HTTP 429 `TOKEN_QUOTA_EXHAUSTED`，不写任何 Conversation。额度检查本身失败时放行（fail-open），只记错误日志。token 额度不支持过期。

**运营报表**：`GET /api/v1/admin/token-usage?groupBy=user|course|day&from=…&to=…`（Bearer `ADMIN_API_TOKEN`；区间左闭右开，默认最近 7 天，按天分组用 UTC 日期）。每行带三类原始 token、加权消耗、`meteredTurns` 和 `unmeteredTurns`（真实 Agent 回复里没计上量的条数，非 0 说明数字被低估）；按用户分组时还有 `grantedTokens`（累计发放）、`lifetimeConsumption`（**全期**加权消耗）和 `balance`（`grantedTokens - lifetimeConsumption`，和上面 429 判定同一口径）。注意 `weightedConsumption` 只统计报表时间窗口，所以不等于 `grantedTokens - balance`。

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
