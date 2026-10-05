# 运营后台 4a：运营账号、登录与管理后台骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用独立的 `Operator` 账号替换 `ADMIN_API_TOKEN` + 自报的 `X-Operator`，并建出能登录的 `apps/admin` 骨架，作为 4b（课程编辑器）和 4c（邀请 / 配额 / 审计页）的前置。

**Architecture:** `apps/api` 新增一张 `Operator` 表、`POST /admin/auth/login` 和 `OperatorAuthGuard`（JWT audience 与学员隔离，每次请求查库确认 `ACTIVE`）；运营由 CLI 直接写进库（不邀请、不发 refresh 令牌）。三个现有 admin 控制器换守卫、从 `request.operator` 取身份。`apps/admin` 是 Next.js 16 的第二个应用，只通过 Server Action 调 `apps/api`，会话是一个 `HttpOnly` cookie，`proxy.ts` 只负责「没会话就去登录」。

**Tech Stack:** NestJS 11、Prisma 6、zod 4、jose（经 `src/auth/tokens.ts`）、`@node-rs/argon2`、nest-commander、Jest 30；Next.js 16 App Router、React 19、Tailwind、shadcn/ui、vitest。

**Spec:** `docs/superpowers/specs/2026-10-01-admin-console-design.md` 第 2–5、8–11 节（本计划只覆盖其中的 4a）。

## Global Constraints

- 令牌 audience：运营 `aivirteach-admin`，学员 `aivirteach-client`；签名密钥沿用 `JWT_SECRET`；claims 为 `sub` = `Operator.id`、`email`；只发 access 令牌，有效期 `OPERATOR_SESSION_TTL`（默认 `8h`，格式同 `ACCESS_TOKEN_TTL`）。
- 表：只加 `Operator`（`id`、`email` 唯一、`passwordHash`、`status ACTIVE|DISABLED`、`failedLoginCount` 默认 0、`lockedUntil?`、`passwordChangedAt`、`createdAt`、`updatedAt`）+ `AuditEvent @@index([createdAt])`。没有 refresh 表、设置令牌表、邀请。
- 登录锁定：连续 5 次失败 → `lockedUntil` = 现在 + 15 分钟；锁定期内正确密码也拒绝；成功登录清零。所有失败统一 401「凭证无效」，不区分邮箱不存在 / 密码错 / 已停用 / 已锁定；邮箱不存在时也做一次密码哈希比较。不使用 `@nestjs/throttler`。
- 守卫：验 JWT（audience、过期）→ 查库要求 `status = ACTIVE` 且令牌 `iat` ≥ `floor(passwordChangedAt / 1000)`；停用与重置密码都立刻使旧令牌失效。
- CLI：`operator:add / reset / disable`，沿用 dry-run、`--operator`、`--reason`、`--execute`；`add` / `reset` 随机生成密码并只在输出里出现一次。
- 审计：运营写操作一律 `OPERATOR` + 运营邮箱；登录相关动作名只有 `admin.auth.login`（成功与失败）与 `admin.auth.locked`。
- cookie：`HttpOnly`、`Secure`、`SameSite=Strict`；变更只走 Server Action；`apps/admin` 不引用 `JWT_SECRET` 和 `DATABASE_URL`，只用 `API_BASE_URL`。
- 迁移手写 SQL，用 `prisma migrate deploy` 应用到本地库；不用 `migrate dev` / `migrate reset`。跑 e2e 前显式传本地 `DATABASE_URL`（`localhost:55432`），`.env.local` 指向生产库。生产库的迁移与 Vercel Root Directory 变更各有 Owen 关卡（Task 1、Task 8）。
- 代码风格：文件 200–400 行、上限 800；匹配现有风格；先写测试；覆盖率不低于 80%；lint 用 `npx eslint --no-fix`，不要跑 `npm run lint`（带 `--fix`）。提交格式 `<type>: <description>`。

## Review Focus

- 邮箱大小写和首尾空格：`Op@X.com ` 与 `op@x.com` 是同一个运营；入库、登录、CLI 一律 trim + 小写。（Task 2）
- 超长或空密码：登录时密码 1–128 位，超长直接 400，不交给 argon2。（Task 2、3）
- 已停用 / 已锁定的运营持有仍在有效期内的 access 令牌：下一次请求就必须 401；重置密码后旧令牌同样 401。（Task 4）
- 学员 access 令牌调 admin 接口、运营 access 令牌调学员接口：都必须 401。（Task 4）
- `operator:add` 对已存在的邮箱：报错而不是覆盖密码；`reset` / `disable` 对不存在的邮箱在 dry-run 阶段就报错。（Task 5）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/prisma/schema.prisma`、`migrations/20261005000000_operator_accounts/migration.sql` | `Operator` 表 + 审计索引 |
| `apps/api/src/auth/tokens.ts`（改） | 令牌签发 / 验证接受 audience 参数，验证结果带 `iat` |
| `apps/api/src/operator-auth/`（新） | `operator-auth.service.ts`（登录、锁定）、`operator-auth.controller.ts`、`operator-auth.guard.ts`、`operator-auth.module.ts` |
| `apps/api/src/admin/commands/operator.command.ts` + `operator-admin.service.ts`（新） | `operator:add / reset / disable` |
| `apps/api/src/admin/admin-courses.controller.ts`、`token-usage/interface/admin-token-usage.controller.ts`（改） | 换守卫，去掉 `OperatorHeader` |
| `packages/admin-contract/`（新） | 登录请求响应 zod schema，api 与 admin 共用 |
| `apps/admin/`（新） | Next.js 16：`app/(auth)/login`、`app/(app)/layout.tsx`、`lib/session.ts`、`lib/api-client.ts`、`proxy.ts` |

---

### Task 1: Schema 与迁移（Owen 关卡）

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261005000000_operator_accounts/migration.sql`
- Create: `mockups/2026-10-05-operator-accounts-diff.html`（前后对比页，样式沿用 `mockups/2026-09-30-migration-a-diff.html`）
- Test: `apps/api/test/schema.e2e-spec.ts`（扩展）

**Interfaces:**
- Produces: Prisma 模型 `Operator { id, email @unique, passwordHash, status: OperatorStatus @default(ACTIVE), failedLoginCount Int @default(0), lockedUntil?, passwordChangedAt DateTime @default(now()), createdAt, updatedAt }`、`enum OperatorStatus { ACTIVE DISABLED }`、`AuditEvent @@index([createdAt])`。

- [ ] **Step 1: 写失败的 e2e 断言**：在 `schema.e2e-spec.ts` 里用 `information_schema` 断言 `Operator` 表及其列、`OperatorStatus` 两个枚举值、`Operator_email_key` 唯一约束、`AuditEvent_createdAt_idx` 存在。
- [ ] **Step 2: 跑 `npm run test:e2e -w api -- schema`（带本地 `DATABASE_URL`）确认失败。**
- [ ] **Step 3: 改 schema 并手写迁移 SQL**；`npx prisma migrate diff --from-schema-datasource --to-schema-datamodel` 对本地库验证没有漂移。
- [ ] **Step 4: 生成对比页并停下，等 Owen 确认**（迁移 SQL；只新增一张表和一个索引，不改现有表的列）。**未确认前不得对任何共享库执行。**
- [ ] **Step 5: 对本地库 `prisma migrate deploy`，e2e 通过。**
- [ ] **Step 6: Commit** `feat: add Operator table`。

### Task 2: 令牌 audience、邮箱规范化与环境变量

**Files:**
- Modify: `apps/api/src/auth/tokens.ts`、`apps/api/src/config/env.ts`
- Create: `apps/api/src/operator-auth/operator-auth.schemas.ts`
- Test: `tokens.spec.ts`、`env.spec.ts`、`operator-auth/operator-auth.schemas.spec.ts`

**Interfaces:**
- Produces: `TOKEN_AUDIENCE_ADMIN = 'aivirteach-admin'`；`signAccessToken(claims, secret, ttl, audience = TOKEN_AUDIENCE)`；`verifyAccessToken(token, secret, audience = TOKEN_AUDIENCE): Promise<AccessTokenClaims & { iat: number }>`（默认值保证学员侧调用不变；`iat` 为 JWT 秒级签发时间）。`EmailSchema`（trim + 小写 + `.email()`）、`LoginSchema`（`email`、`password` 1–128 位）。`Env.OPERATOR_SESSION_TTL`（默认 `'8h'`）。

- [ ] **Step 1: 写失败的测试**：用 admin audience 签的令牌用默认 audience 验证抛 `InvalidTokenError`，反之亦然；验证结果含数值型 `iat`；`EmailSchema.parse(' Op@X.com ')` 得 `op@x.com`；`LoginSchema` 拒绝空密码与 129 位密码；`env.spec.ts` 断言 `OPERATOR_SESSION_TTL` 默认 `8h`。
- [ ] **Step 2: 运行确认失败；Step 3: 实现；Step 4: 运行确认通过，并确认学员侧 `auth` 与 `jwt-auth.guard` 既有测试全部不变地通过。**
- [ ] **Step 5: Commit** `feat: audience-aware access tokens and operator login schema`。

### Task 3: 运营登录、锁定与接口

**Files:**
- Create: `apps/api/src/operator-auth/operator-auth.service.ts`、`operator-auth.controller.ts`、`operator-auth.module.ts`；Modify: `app.module.ts`
- Test: `operator-auth.service.spec.ts`、`apps/api/test/operator-auth.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `LoginSchema`、`signAccessToken`/`TOKEN_AUDIENCE_ADMIN`、`Env.OPERATOR_SESSION_TTL`；现有 `verifyPassword`、`AuditService.record`、`ttlToSeconds`。
- Produces: `OperatorAuthService.login(email: string, password: string): Promise<{ accessToken: string; expiresIn: number }>`；路由 `POST /api/v1/admin/auth/login`（200）。`DENIED = '凭证无效'`。

- [ ] **Step 1: 写失败的测试**（service 用 mock Prisma，沿用 `auth.service.spec.ts` 的写法），每条一个 `it`：成功登录返回令牌、清零计数、记 `admin.auth.login` success；密码错 → 401「凭证无效」、计数 +1、记 failure；邮箱不存在 → 同样 401 且 `verifyPassword`（对固定的假哈希）仍被调用一次；第 5 次失败置 `lockedUntil` ≈ 现在 + 15 分钟并记 `admin.auth.locked`；锁定期内正确密码 → 401 且计数不变；锁定过期后正确密码成功；`DISABLED` → 401；大小写 / 空格不同的邮箱登录同一个运营。e2e 用 supertest：登录成功拿到令牌；学员 `POST /auth/login` 不接受运营凭证。
- [ ] **Step 2: 运行确认失败；Step 3: 实现 `login`**（失败计数与锁定写在同一次 `update`，避免读改写竞态时多放一次尝试）；**Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** `feat: operator login with database-backed lockout`。

### Task 4: OperatorAuthGuard 并替换旧守卫

**Files:**
- Create: `apps/api/src/operator-auth/operator-auth.guard.ts`
- Modify: `admin-courses.controller.ts`（`AdminCoursesController`、`AdminCourseCreateController`）、`token-usage/interface/admin-token-usage.controller.ts`、`admin.module.ts`、`config/env.ts`（移除 `ADMIN_API_TOKEN`）
- Delete: `admin/admin-api-token.guard.ts` 及其 spec
- Modify tests: `admin-courses.controller.spec.ts`、`env.spec.ts`、`test/lesson-blocks.e2e-spec.ts`、`test/lesson-blocks-draft-writes.e2e-spec.ts`、`test/token-usage-admin.e2e-spec.ts`，以及仍引用 `ADMIN_API_TOKEN` 的 `chat/agent-client.spec.ts`、`workspace/*.spec.ts`、`auth/jwt-auth.guard.spec.ts` 的 env 夹具
- Test: `operator-auth.guard.spec.ts`

**Interfaces:**
- Consumes: `verifyAccessToken(..., TOKEN_AUDIENCE_ADMIN)`（含 `iat`）。
- Produces: `OperatorAuthGuard implements CanActivate`，通过后设置 `request.operator = { id: string; email: string }`；装饰器 `@CurrentOperator()` 返回 `request.operator.email`，替换三个控制器里的 `OperatorHeader`（这些方法的 `operator: string` 参数含义不变，下游服务不用改）。

- [ ] **Step 1: 写失败的测试**：缺少 / 格式错误 / 过期令牌 → 401；学员令牌（audience 不符）→ 401；有效令牌但库里 `DISABLED` → 401；令牌 `iat` 早于 `passwordChangedAt`（按秒）→ 401；`ACTIVE` 且 `iat` 合格 → 通过且 `request.operator` 正确。e2e：用运营令牌调 `POST /admin/courses/:slug/draft`，审计里 `actorId` 是运营邮箱而不是请求头；`X-Operator` 头被忽略；学员令牌调 `GET /admin/token-usage` → 401；运营令牌调学员 `GET /auth/me` → 401。
- [ ] **Step 2: 运行确认失败；Step 3: 实现守卫与装饰器，换掉三个控制器，删除旧守卫与 env 变量，修完所有引用处。**
- [ ] **Step 4: 跑 `npm test -w api`、本地库 `npm run test:e2e -w api`，全部通过；`npx tsc --noEmit` 干净。**
- [ ] **Step 5: Commit** `feat: authenticate admin API with operator accounts; drop ADMIN_API_TOKEN`。

### Task 5: 运营 CLI

**Files:**
- Create: `apps/api/src/admin/commands/operator.command.ts`、`apps/api/src/admin/operator-admin.service.ts`；Modify: `admin.module.ts`
- Test: `operator.command.spec.ts`、`operator-admin.service.spec.ts`

**Interfaces:**
- Consumes: 现有 `hashPassword`、`AuditService.record`、`EmailSchema`；`quota-tokens.command.ts` 的选项解析写法。
- Produces: 命令 `operator:add <email>`、`operator:reset <email>`、`operator:disable <email>`；`OperatorAdminService.add(email, ctx)`、`reset(email, ctx)`、`disable(email, ctx)`，`ctx = { operator: string; reason: string; execute: boolean }`；`add` / `reset` 返回的 JSON 含一次性 `password`（`crypto.randomBytes` 生成，至少 16 字符）。`reset` 同时更新 `passwordChangedAt`、清零 `failedLoginCount` 与 `lockedUntil`；`disable` 置 `DISABLED`。

- [ ] **Step 1: 写失败的测试**：dry-run 不写库、不输出密码；`--execute` 下 `add` 输出 `password`、库里只有哈希、记审计；`add` 已存在的邮箱 → 报错且不覆盖；`reset` 后旧令牌失效所需的 `passwordChangedAt` 被更新、锁定被清除；`reset` / `disable` 对不存在的邮箱在 dry-run 就报「找不到运营」；邮箱大小写与空格被规范化。
- [ ] **Step 2: 运行确认失败；Step 3: 实现；Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** `feat: operator:add, operator:reset and operator:disable CLI commands`。

### Task 6: `packages/admin-contract` 与 `apps/admin` 骨架

**Files:**
- Create: `packages/admin-contract/`（`package.json`、`src/auth.ts`、`src/index.ts`、测试）
- Create: `apps/admin/`（Next.js 16 App Router、Tailwind、shadcn/ui 的 button / input / label / card、vitest 配置、`app/layout.tsx`、`app/page.tsx`）
- Modify: 根 `package.json` workspaces 已含 `apps/*`、`packages/*`，确认 `npm run build/test --workspaces` 包含新包
- Modify: `apps/api` 的 `operator-auth.schemas.ts` 改为从 `@aivirteach/admin-contract` 导入 `LoginSchema` 与响应 schema

**Interfaces:**
- Produces: `@aivirteach/admin-contract` 导出 `LoginSchema`、`LoginResponseSchema`（`{ accessToken, expiresIn }`）及其推导类型。`apps/admin/.env.example` 只含 `API_BASE_URL`、`NEXT_PUBLIC_CLIENT_ORIGIN`。

- [ ] **Step 1: 写失败的测试**：contract 包对非法邮箱 / 空密码报错、对合法输入通过；api 侧原有 schema 测试在改为引用该包后保持通过；`apps/admin` 一个冒烟测试（`/` 页面渲染不抛错）。
- [ ] **Step 2–4: 实现并让 `npm run build` 与 `npm test` 在 workspaces 范围内通过；确认 `apps/admin` 的源码里搜不到 `JWT_SECRET`、`DATABASE_URL`。**
- [ ] **Step 5: Commit** `feat: scaffold apps/admin and packages/admin-contract`。

### Task 7: 会话、`proxy.ts` 与登录页

**Files:**
- Create: `apps/admin/lib/session.ts`、`lib/api-client.ts`、`proxy.ts`、`app/(auth)/login/page.tsx` + `actions.ts`、`app/(app)/layout.tsx`（登录后壳，带退出按钮）
- Test: `lib/session.test.ts`、`proxy.test.ts`、`lib/api-client.test.ts`、登录页组件测试（Testing Library）

**Interfaces:**
- Consumes: `@aivirteach/admin-contract`；`apps/api` 的 `POST /admin/auth/login`。
- Produces: `setSession(accessToken: string, expiresIn: number)` / `clearSession()`（Server Action 内用 `cookies()`，`HttpOnly`、`Secure`、`SameSite=Strict`，`maxAge` = `expiresIn`）；`apiFetch(path: string, init?: RequestInit): Promise<Response>`（服务端调用，带 access；收到 401 → `clearSession()` 并 `redirect('/login')`）；`proxy(request: NextRequest): NextResponse`（无会话 cookie 且路径不是 `/login` → 重定向 `/login`）。

- [ ] **Step 1: 写失败的测试**：无会话访问 `/courses` → 重定向 `/login`；有会话访问 `/login` 不被拦；cookie 三项属性齐全且 `maxAge` 等于 `expiresIn`；`apiFetch` 遇 401 清 cookie 并跳转；登录页：错误凭证显示统一文案「凭证无效」、成功跳转 `/`；退出按钮清 cookie 并回到 `/login`。
- [ ] **Step 2–4: 实现并通过；`npm run build -w apps/admin` 通过。**
- [ ] **Step 5: Commit** `feat: admin session cookie, proxy redirect and login page`。

### Task 8: 联调、切换与上线（含 Owen 关卡）

**Files:**
- Modify: `README.md`（运营后台、`operator:*` 命令、取消 `ADMIN_API_TOKEN` 的说明）、`.env.example`、`docs/superpowers/specs/2026-10-01-admin-console-design.md`（第 11 节实施状态）
- Test: `apps/api/test/operator-auth.e2e-spec.ts`（扩展）

- [ ] **Step 1: 端到端（本地库，显式 `DATABASE_URL`）**：`operator:add --execute` → 用输出的密码 `POST /admin/auth/login` → 带令牌调 `POST /admin/courses/:slug/draft` → 审计里该事件 `actorType = OPERATOR`、`actorId` 为运营邮箱。再启动 `apps/admin`，浏览器走一遍登录 → 退出，记录结果。
- [ ] **Step 2: 切换顺序写进 README**：① 对生产库应用迁移（Task 1 已确认的 SQL，经 Neon MCP 在事务内执行并补写 `_prisma_migrations`）→ ② 部署 api（此刻旧的 `ADMIN_API_TOKEN` 调用立即失效，Swagger 页需要改用运营令牌）→ ③ 用显式生产 `DATABASE_URL` 执行 `operator:add` 创建第一个运营 → ④ 部署 `apps/admin` 的第二个 Vercel 项目。
- [ ] **Step 3: 停下，等 Owen 确认后再执行 ①–④**；改 Vercel 现有项目的 Root Directory 前，先在预览环境验证一次完整部署。
- [ ] **Step 4: 全量验证**：`npm test`、本地 `npm run test:e2e`、`tsc --noEmit`、`nest build`、`npx eslint --no-fix` 对改动文件无错误。
- [ ] **Step 5: Commit** `docs: operator auth rollout and admin console 4a notes`。
