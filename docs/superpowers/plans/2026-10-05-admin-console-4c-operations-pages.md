# 运营后台 4c：邀请、配额、审计页面与接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运营在管理后台里邀请学员、发配额（分钟 / token）、查看 token 余额与用量、翻审计记录，不再用 CLI 做这些日常操作。

**Architecture:** `apps/api` 补齐 spec 第 7 节的读写接口（学员列表、配额流水、审计、邀请、发配额），三个列表共用一套游标分页；写接口只是 `AdminService` 现有方法的 HTTP 外壳，身份取自 `request.operator.email`。`apps/admin` 用 Server Component 读、Server Action 写，三个页面共用同一套表格 / 分页 / 「原因」表单组件。

**Tech Stack:** NestJS 11、Prisma 6、zod 4、Jest 30、supertest；Next.js 16 App Router、React 19、Tailwind、shadcn/ui、vitest + Testing Library。

**Spec:** `docs/superpowers/specs/2026-10-01-admin-console-design.md` 第 5、6（邀请、配额页）、7、9、10 节。

**前置：** 4a 已合并（`OperatorAuthGuard`、`@CurrentOperator()`、`packages/admin-contract`、`apps/admin` 的登录壳与 `apiFetch`）。与 4b 互不依赖，可并行。

## Global Constraints

- 所有新接口挂在 `/api/v1/admin/…`，用 `OperatorAuthGuard`；写接口的 `operator` 取自 `request.operator.email`，不接受请求头 / 请求体里的自报身份。
- 请求 / 响应 zod schema 放 `packages/admin-contract`，Nest 与 Next 共用。
- 游标分页：按 `createdAt` 倒序、`id` 倒序兜底；`limit` 默认 50、最大 100（超出 400，不静默截断）；`cursor` 无效 → 400。
- 写操作必须带非空 `reason`（trim 后至少 1 个字符），审计沿用 `AdminService` 现有动作名（`admin.inviteUser`、`admin.grantQuota`、`admin.grantTokenQuota`）。
- 发配额：`minutes` / `tokens` 都是正整数，单次上限 2,147,483,647（超出 400）；本块不做扣减 / 撤销入口。
- 明文邀请令牌只在 `POST /admin/invitations` 的当次响应里出现，不写日志，页面里刷新后不可见。
- `balance = grantedTokens − lifetimeConsumption`，和聊天 429 的判定同口径，沿用现有 `GET /admin/token-usage`。
- `apps/admin` 只经 Server Component / Server Action 调 API；不引用 `JWT_SECRET`、`DATABASE_URL`。
- 本块无数据库迁移（`AuditEvent.createdAt` 索引在 4a 已加）。
- 代码风格：文件 200–400 行、上限 800；匹配现有风格；先写测试；覆盖率不低于 80%；lint 用 `npx eslint --no-fix`；跑 e2e 前显式传本地 `DATABASE_URL`（`localhost:55432`）；提交格式 `<type>: <description>`。

## Review Focus

- 多条记录 `createdAt` 完全相同（批量发放、同一毫秒的审计）：翻页不能重复也不能漏。（Task 1，Task 2、3 复用）
- 邮箱关键字含 `%`、`_` 或大小写不同：按字面匹配，不被当成通配符。（Task 1）
- 对已激活（`ACTIVE`）学员再点「邀请」：API 返回 409，不能悄悄签出一个能重设其密码的令牌。（Task 4）
- 发配额的数量为 0、负数、小数、超过 2,147,483,647，或学员邮箱不存在：400 / 404，界面显示后端文案，不吞掉。（Task 4、8）
- 审计页的学员 id 对应的学员已被删除：`label` 为 `null`，不报错；一页里的学员邮箱只用一次批量查询解析。（Task 3）
- token 余额报表要包含「有授予但窗口内无活动」的学员，否则运营看不到他们的余额。（Task 5）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/src/common/cursor-pagination.ts`（新） | 游标编码 / 解码、`CursorQuerySchema`、Prisma `where` 片段、`toPage` |
| `apps/api/src/admin/users/`（新） | `admin-users.service.ts`、`admin-users.controller.ts`（`GET /admin/users`） |
| `apps/api/src/admin/quotas/`（新） | `admin-quotas.service.ts`、`admin-quotas.controller.ts`（`GET`、`POST /admin/quotas`） |
| `apps/api/src/admin/invitations/`（新） | `admin-invitations.controller.ts`（`POST /admin/invitations`） |
| `apps/api/src/admin/audit/`（新） | `audit-query.service.ts`、`admin-audit.controller.ts`（`GET /admin/audit`） |
| `apps/api/src/token-usage/`（改） | 报表补上「有授予无活动」的学员 |
| `packages/admin-contract/src/{pagination,users,quotas,invitations,audit,token-usage}.ts`（新） | 各接口 schema |
| `apps/admin/components/`（新） | `data-table.tsx`、`cursor-pager.tsx`、`reason-field.tsx`、`one-time-secret.tsx`、`nav.tsx` |
| `apps/admin/app/(app)/{invitations,quotas,audit}/`（新） | 三个页面及各自的 `actions.ts` |

---

### Task 1: 游标分页与学员列表

**Files:**
- Create: `apps/api/src/common/cursor-pagination.ts`、`apps/api/src/admin/users/admin-users.service.ts`、`admin-users.controller.ts`；`packages/admin-contract/src/pagination.ts`、`users.ts`
- Modify: `apps/api/src/admin/admin.module.ts`
- Test: `common/cursor-pagination.spec.ts`、`admin/users/admin-users.service.spec.ts`、`apps/api/test/admin-users.e2e-spec.ts`

**Interfaces:**
- Produces: `encodeCursor(row: { createdAt: Date; id: string }): string`；`decodeCursor(cursor: string): { createdAt: Date; id: string }`（无效 → `BadRequestException('cursor 无效')`）；`cursorWhere(cursor?: string)`（返回 `{ OR: [{ createdAt: { lt } }, { createdAt, id: { lt } }] }` 或 `undefined`）；`toPage<T extends { createdAt: Date; id: string }, U>(rows: T[], limit: number, map: (row: T) => U): CursorPage<U>`（`rows` 是多取 1 条的结果；`CursorPage<U> = { items: U[]; nextCursor: string | null }`）；`CursorQuerySchema`（`limit`、`cursor?`）。
- Produces: `AdminUsersService.list(query: { q?: string; limit: number; cursor?: string }): Promise<CursorPage<{ id: string; email: string; status: UserStatus; createdAt: string }>>` 与 `findByEmail(email: string): Promise<{ id: string; status: UserStatus } | null>`；路由 `GET /api/v1/admin/users?q=&limit=&cursor=`；contract 导出 `CursorPageSchema(item)`、`AdminUserSchema`、`AdminUsersQuerySchema`。

- [ ] **Step 1: 写失败的测试**：`cursor-pagination.spec.ts`——编码再解码得回同一行；乱码 / 缺字段的 cursor → 400；`toPage` 在 `rows.length > limit` 时 `nextCursor` 指向第 `limit` 条，否则为 `null`；`limit` 0、101 被 schema 拒绝。`admin-users.e2e-spec.ts`——种 120 个学员，其中 5 个 `createdAt` 完全相同：连续翻页取完，总数 120、无重复；`q=ab_c` 只匹配邮箱字面含 `ab_c` 的学员（不把 `_` 当通配符），`q=%` 同理；`q` 大小写不敏感；无令牌 / 学员令牌 → 401。
- [ ] **Step 2: 运行确认失败；Step 3: 实现**（用 `findMany({ take: limit + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })`；关键字用 Prisma `contains` + `mode: 'insensitive'`，不拼 SQL）；**Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** `feat: cursor pagination helper and GET /admin/users`。

### Task 2: 配额流水列表

**Files:**
- Create: `apps/api/src/admin/quotas/admin-quotas.service.ts`、`admin-quotas.controller.ts`；`packages/admin-contract/src/quotas.ts`
- Modify: `admin.module.ts`
- Test: `admin-quotas.service.spec.ts`、`apps/api/test/admin-quotas.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `CursorQuerySchema`、`cursorWhere`、`toPage`。
- Produces: `AdminQuotasService.list(query: { email?: string; limit: number; cursor?: string }): Promise<CursorPage<QuotaEntry>>`，`QuotaEntry = { id: string; email: string; minutesDelta: number; tokensDelta: number; expiresAt: string | null; createdAt: string }`；`GET /api/v1/admin/quotas?email=&limit=&cursor=`；contract 导出 `QuotaEntrySchema`、`QuotasQuerySchema`。

- [ ] **Step 1: 写失败的测试**：流水按时间倒序；`email` 筛选只返回该学员（大小写不敏感）、不存在的邮箱返回空页而不是 404；`tokensDelta` 为负的 restart 结算流水原样返回；分页同 Task 1（含同一毫秒的多条）。
- [ ] **Step 2: 运行确认失败；Step 3: 实现（一次 `include: { user: { select: { email: true } } }` 取邮箱，不做逐行查询）；Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** `feat: GET /admin/quotas ledger listing`。

### Task 3: 审计列表

**Files:**
- Create: `apps/api/src/admin/audit/audit-query.service.ts`、`admin-audit.controller.ts`；`packages/admin-contract/src/audit.ts`
- Modify: `admin.module.ts`
- Test: `audit-query.service.spec.ts`、`apps/api/test/admin-audit.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1 的分页工具。
- Produces: `AuditQueryService.list(query: { actorType?: AuditActorType; actor?: string; action?: string; targetType?: string; limit: number; cursor?: string }): Promise<CursorPage<AuditItem>>`，`AuditItem = { id: string; actor: { type: AuditActorType; id: string | null; label: string | null }; action: string; success: boolean; targetType: string | null; targetId: string | null; reason: string | null; metadata: unknown; createdAt: string }`；`GET /api/v1/admin/audit`；contract 导出 `AuditItemSchema`、`AuditQuerySchema`。`actor` 参数是邮箱：命中 `OPERATOR` 的 `actorId` 等于该邮箱，或 `USER` 的 `actorId` 是该邮箱学员的 id。只读，不碰 `AuditService`（它仍是唯一的写入口）。

- [ ] **Step 1: 写失败的测试**：`label`——`OPERATOR` 为邮箱本身，`USER` 为学员邮箱，学员已删除时为 `null`，`SYSTEM` 的 `id` 与 `label` 都是 `null`；一页 50 条里有 30 个不同学员 id 时，学员邮箱只发 1 次 `user.findMany`；按 `actorType`、`action`、`targetType` 筛选；`actor=某邮箱` 同时命中该邮箱作为运营的事件和该学员自己的事件；`limit=101` → 400；同一毫秒的多条事件翻页不重复不遗漏；`metadata` 原样返回。
- [ ] **Step 2: 运行确认失败；Step 3: 实现；Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** `feat: GET /admin/audit with actor labels`。

### Task 4: 邀请与发配额写接口

**Files:**
- Create: `apps/api/src/admin/invitations/admin-invitations.controller.ts`；`packages/admin-contract/src/invitations.ts`
- Modify: `apps/api/src/admin/quotas/admin-quotas.controller.ts`（加 `POST`）、`packages/admin-contract/src/quotas.ts`、`admin.module.ts`
- Test: `admin-invitations.controller.spec.ts`、`admin-quotas.controller.spec.ts`（扩展）、`apps/api/test/admin-writes.e2e-spec.ts`

**Interfaces:**
- Consumes: 现有 `AdminService.inviteUser(email, operator, reason): Promise<InviteResult>`、`grantQuota(email, minutes, operator, reason)`、`grantTokenQuota(email, tokens, operator, reason)`；4a 的 `@CurrentOperator()`。
- Produces: `POST /api/v1/admin/invitations`，body `InviteBodySchema = { email, reason }`（email 沿用 4a 的 `EmailSchema` 规范化），201 返回 `InviteResult`（`userId`、`email`、`invitationToken`、`expiresAt`）；学员已 `ACTIVE` → 409「该学员已激活，不需要邀请」。`POST /api/v1/admin/quotas`，body `GrantBodySchema` = `{ kind: 'minutes', email, minutes, reason } | { kind: 'tokens', email, tokens, reason }`（数量正整数且 ≤ 2147483647），201 返回 `QuotaEntry`。`AdminService` 本身不改。

- [ ] **Step 1: 写失败的测试**：邀请——新邮箱 201 且审计 `admin.inviteUser` 的 `actorId` 是运营邮箱、`reason` 被记录；再次邀请仍是 `INVITED` 的学员 201（新令牌）；邀请 `ACTIVE` 学员 409 且库里没有新增 `Invitation`；`reason` 为空或全空格 → 400；响应之外的任何地方（审计 `metadata`、日志）不含明文令牌。发配额——两种 kind 各成功一次并记对应审计动作；数量 0、-1、1.5、2147483648 → 400；不存在的邮箱 → 404；缺 `kind` → 400；`X-Operator` 头被忽略。
- [ ] **Step 2: 运行确认失败；Step 3: 实现（controller 只做校验与转发，409 检查放在 controller 调用 `AdminUsersService` 的一次 `findByEmail`）；Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** `feat: POST /admin/invitations and POST /admin/quotas`。

### Task 5: token 报表补全「有授予无活动」的学员

**Files:**
- Modify: `apps/api/src/token-usage/application/usage-report-read-model.ts`、`infrastructure/prisma-usage-read-model.ts`、`application/get-usage-report.ts`；`packages/admin-contract/src/token-usage.ts`（新增，放 `UsageReportRowSchema`）
- Test: `get-usage-report.spec.ts`（扩展）、`apps/api/test/token-usage-admin.e2e-spec.ts`（扩展）

**Interfaces:**
- Produces: `UsageReportReadModel.listGrantedUsers(excludeIds: string[]): Promise<Array<{ key: string; label: string }>>`（有过非 0 `tokensDelta` 流水、且不在 `excludeIds` 里的学员，`label` 与现有 `user` 分组行的 label 口径一致）。`GetUsageReport.execute` 在 `groupBy = 'user'` 时把这些学员追加成零用量行（`weightedConsumption`、各 token 数与 `meteredTurns`、`unmeteredTurns` 全为 0），并照常算 `grantedTokens`、`lifetimeConsumption`、`balance`（他们窗口外可能有消耗，必须用全期用量算）。其他分组不变。

- [ ] **Step 1: 写失败的测试**：学员只有授予、窗口内没聊天 → 出现在 `groupBy=user` 结果里，`balance = grantedTokens − lifetimeConsumption`；该学员窗口外有消耗时 `lifetimeConsumption` 非 0；窗口内有活动的学员不重复出现；`groupBy=course|day` 结果不变；没有任何授予流水的学员仍不出现。
- [ ] **Step 2: 运行确认失败；Step 3: 实现；Step 4: 运行确认通过，现有 token-usage 测试全部不变地通过。**
- [ ] **Step 5: Commit** `fix: include granted-but-inactive users in token usage report`。

### Task 6: 管理后台共用组件与导航

**Files:**
- Create: `apps/admin/components/data-table.tsx`、`cursor-pager.tsx`、`reason-field.tsx`、`one-time-secret.tsx`、`nav.tsx`；`apps/admin/lib/query.ts`、`lib/action-state.ts`
- Modify: `apps/admin/app/(app)/layout.tsx`（加入 `Nav`）
- Test: 各组件的 `*.test.tsx`、`lib/query.test.ts`

**Interfaces:**
- Produces: `DataTable<T>({ columns: Array<{ header: string; cell: (row: T) => ReactNode }>; rows: T[]; empty: string })`；`CursorPager({ nextCursor: string | null; basePath: string; params: Record<string, string | undefined> })`（有 `nextCursor` 才显示「下一页」，URL 带 `cursor`；当前有 `cursor` 时显示「回到第一页」）；`ReasonField()`（名为 `reason` 的必填文本框，空格不算填写）；`OneTimeSecret({ label: string; value: string })`（显示 `value` 与「复制」按钮，复制后提示「已复制」；值只存在于组件 state）；`Nav()`（链接：邀请 `/invitations`、配额 `/quotas`、审计 `/audit`，当前路径高亮；课程入口由 4b 加）；`buildQuery(params: Record<string, string | undefined>): string`（跳过空值并编码）；`ActionState = { ok: true; message?: string; data?: unknown } | { ok: false; message: string } | null`。

- [ ] **Step 1: 写失败的测试**：`DataTable` 空数据显示 `empty`；`CursorPager` 无 `nextCursor` 不渲染「下一页」、有 `cursor` 才渲染「回到第一页」、链接保留其他筛选参数；`ReasonField` 空格提交被浏览器校验拦下；`OneTimeSecret` 点击复制调用 `navigator.clipboard.writeText(value)`；`buildQuery` 对 `%`、空格、中文正确编码；`Nav` 当前路径高亮。
- [ ] **Step 2–4: 实现并通过；`npm run build -w apps/admin` 通过。**
- [ ] **Step 5: Commit** `feat: shared admin table, pager, reason field and nav`。

### Task 7: 邀请页

**Files:**
- Create: `apps/admin/app/(app)/invitations/page.tsx`、`actions.ts`、`invite-form.tsx`
- Test: `invite-form.test.tsx`、`actions.test.ts`、`page.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `GET /admin/users`、Task 4 的 `POST /admin/invitations`；Task 6 的组件；4a 的 `apiFetch`。
- Produces: `inviteAction(prev: ActionState, form: FormData): Promise<ActionState>`（成功时 `data = InviteResult`）；页面 `/invitations?q=&cursor=`。

- [ ] **Step 1: 写失败的测试**：页面按 `q`、`cursor` 取学员列表并渲染邮箱、状态、创建时间，`CursorPager` 保留 `q`；表单提交成功后显示 `OneTimeSecret`（令牌）与过期时间，重新渲染页面（刷新）后不再出现；API 409 / 400 的文案原样显示在表单上方；`inviteAction` 用 `apiFetch`、缺 `reason` 不发请求；成功后 `revalidatePath('/invitations')`。
- [ ] **Step 2–4: 实现并通过。**
- [ ] **Step 5: Commit** `feat: admin invitations page`。

### Task 8: 配额页

**Files:**
- Create: `apps/admin/app/(app)/quotas/page.tsx`、`actions.ts`、`grant-form.tsx`、`balances-table.tsx`
- Test: `grant-form.test.tsx`、`actions.test.ts`、`page.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `GET /admin/quotas`、Task 4 的 `POST /admin/quotas`、Task 5 的 `GET /admin/token-usage?groupBy=user`（窗口取近 7 天，沿用默认）；Task 6 的组件。
- Produces: `grantAction(prev: ActionState, form: FormData): Promise<ActionState>`（`kind` 来自表单单选；数量转成整数后再发）；页面 `/quotas?email=&cursor=`，三块：发放表单、token 余额与用量表（邮箱、累计发放、全期消耗、余额，余额为负用红色）、发放记录（`tokensDelta` 带正负号，分钟与 token 两列）。

- [ ] **Step 1: 写失败的测试**：表单选 `minutes` / `tokens` 时数量输入的标签随之变化；数量为 0、负数、小数时客户端拦下，超过上限由后端 400 的文案显示；邮箱不存在 → 显示后端 404 文案；成功后显示「已发放」并 `revalidatePath('/quotas')`；余额表包含只有授予无活动的学员（用 Task 5 的响应夹具）；发放记录按 `email` 筛选并保留在分页链接里；负的结算流水显示为 `-12,345`。
- [ ] **Step 2–4: 实现并通过。**
- [ ] **Step 5: Commit** `feat: admin quotas page`。

### Task 9: 审计页

**Files:**
- Create: `apps/admin/app/(app)/audit/page.tsx`、`audit-filters.tsx`、`actor-badge.tsx`
- Test: `audit-filters.test.tsx`、`actor-badge.test.tsx`、`page.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `GET /admin/audit`；Task 6 的组件。
- Produces: 页面 `/audit?actorType=&actor=&action=&targetType=&cursor=`；`ActorBadge({ actor: AuditItem['actor'] })`（运营 / 学员 / 系统三种颜色标签 + `label`，`label` 为 `null` 时显示「已删除的学员」或 id）；筛选条为 GET 表单（无需 Server Action），顶部「全部 / 只看运营 / 只看学员」三个快捷链接（对应 `actorType` 参数）。

- [ ] **Step 1: 写失败的测试**：默认视图不带 `actorType`；点「只看运营」链接带 `actorType=OPERATOR`；分页链接保留全部筛选；每行展示时间、`ActorBadge`、动作、成功 / 失败、目标、原因；失败事件（如 `admin.auth.login` 的 `success=false`）有醒目标记；`metadata` 以折叠的 JSON 展示，不渲染为 HTML；空结果显示「没有符合条件的记录」。
- [ ] **Step 2–4: 实现并通过。**
- [ ] **Step 5: Commit** `feat: admin audit page`。

### Task 10: 联调与上线

**Files:**
- Modify: `README.md`（运营后台页面清单、`ADMIN_API_TOKEN` 已移除的说明若 4a 未写则补）、`docs/superpowers/specs/2026-10-01-admin-console-design.md`（第 11 节：4c 状态）
- Test: `apps/api/test/admin-console-4c.e2e-spec.ts`

- [ ] **Step 1: 端到端（本地库，显式 `DATABASE_URL`）**：运营登录 → `POST /admin/invitations` → 学员用令牌 `POST /auth/invitations/accept` → `POST /admin/quotas`（tokens）→ `GET /admin/token-usage?groupBy=user` 中看到余额 → `GET /admin/audit?actor=<运营邮箱>` 中依次看到 `admin.inviteUser`、`admin.grantTokenQuota`，`actor.label` 为运营邮箱。
- [ ] **Step 2: 浏览器走一遍**：启动本地 `apps/api` 与 `apps/admin`，在三个页面各做一次真实操作（邀请一个测试邮箱、发配额、按运营筛选审计），把结果记录在 PR 描述里。
- [ ] **Step 3: 全量验证**：`npm test`、本地 `npm run test:e2e`、`tsc --noEmit`、`nest build`、`npm run build -w apps/admin`、`npx eslint --no-fix` 对改动文件无错误。
- [ ] **Step 4: 停下，等 Owen 确认后再部署**：本块无迁移，顺序为部署 api → 部署 admin。部署是手动操作，不自动触发。
- [ ] **Step 5: Commit** `docs: admin console 4c rollout notes`。
