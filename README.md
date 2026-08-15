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

## 本地开发

```bash
npm install
cp .env.example .env      # 至少要填 JWT_SECRET，见下方生成方式
npm run db:up              # 起本地 Postgres（docker-compose，端口 55432）
npx prisma migrate dev
npm run start:dev          # http://localhost:4000/docs
```

生成本地 `JWT_SECRET`：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

## 环境变量

由 `src/config/env.ts` 用 Zod 在启动时强校验，缺一个直接崩，不会带着错配置跑起来。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | Postgres 连接串 |
| `JWT_SECRET` | 是 | ≥32 字符，生产环境从 Vercel env 注入，绝不提交进仓库 |
| `ACCESS_TOKEN_TTL` | 否，默认 `15m` | jose 简单格式：数字+单位 |
| `REFRESH_TOKEN_TTL_DAYS` | 否，默认 `30` | |
| `INVITATION_TTL_DAYS` | 否，默认 `7` | |
| `PORT` | 否，默认 `4000` | Vercel 上由平台接管，本地开发才用得到 |
| `CORS_ORIGINS` | 否，默认 `tauri://localhost` | 逗号分隔白名单；client 桌面端（Tauri v2 webview）的源是 `tauri://localhost`，本地网页调试再加 `http://localhost:3001` |

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

封测期没有 admin 后台网页——发邀请、建课程、开课、发额度这些运营操作量很小，做一整套带鉴权的管理网页不划算，所以做成了一个命令行工具（`nest-commander`），入口是 `npm run cli`。谁要执行，就在自己电脑上（或有权限访问生产库的机器上）跑这个命令，天然就是"内部人员本机操作"的权限模型，不用另外造一套 admin 登录态。

| 命令 | 参数 | 作用 |
|---|---|---|
| `invite <email>` | | 邀请一个用户，生成一次性 `invitationToken` |
| `course:create <slug> <title>` | `--imageDigest`（可选） | 新建课程，同时建第一个未发布的版本 |
| `enroll <email> <courseSlug>` | | 给用户开课 |
| `quota:grant <email> <minutes>` | | 给用户发运行额度（分钟） |

所有命令都要求 `--operator`（谁在操作）和 `--reason`（为什么），并且**默认 dry-run**——不加 `--execute` 只打印将要发生的变更、不落库。这两点不是可选的：目的是让审计日志（`AuditEvent` 表）永远能查到"谁、为什么、改了什么"，而不是留一堆无主的写操作。

## 造第一个账号（联调用）

```bash
# 本地跑（连的是 .env 里配置的库）
npm run cli -- invite someone@example.com -o "你的邮箱" -r "联调测试账号" --execute
# 拿到返回的 invitationToken，再调 POST /auth/invitations/accept 激活

npm run cli -- course:create demo-course "Demo Course" -o "你的邮箱" -r "联调用课程" --execute
npm run cli -- enroll someone@example.com demo-course -o "你的邮箱" -r "开课" --execute
npm run cli -- quota:grant someone@example.com 60 -o "你的邮箱" -r "发额度" --execute
```

要对生产库操作，先 `vercel env pull .env.production --environment production --yes`，`source` 进去再跑同样的命令，跑完把临时文件删掉。

## 测试

```bash
npm run test        # 单元测试
npm run test:e2e    # e2e
npm run test:cov    # 覆盖率
```

Jest 需要 `--experimental-vm-modules`（已经写进 npm scripts 里了）——因为鉴权模块动态 `import()` 了纯 ESM 的 `jose`，这是 Vercel serverless 运行时兼容 `jose` 的必要写法，不是历史遗留。

## 已知限制

- 除了上面那个联调种子账号，库里没有其他数据，没有 seed 脚本
- `main` 与 GitHub `origin/main` 历史有分叉，还没有开 PR 合并
- CI 还没接（对应 Linear SRV-001）
- `ACCESS_TOKEN_TTL` / `CORS_ORIGINS` / `PORT` / `INVITATION_TTL_DAYS` / `REFRESH_TOKEN_TTL_DAYS` 这几个纯配置项在 Vercel 上被误标成了 sensitive，导致 `vercel env pull` 拉不出真实值（生产运行不受影响，只是本地没法照抄这几个值）；要清理的话去 Vercel 项目设置里把它们删掉重加成非 sensitive
