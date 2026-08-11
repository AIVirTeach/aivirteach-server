# AIVirTeach Server — 基础设施与自签鉴权 实施计划（计划 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 NestJS 骨架从 Clerk/Stripe 切换到自签 JWT + 邀请制，建立本地可复现的 Postgres/Redis 环境与核心数据模型，并提供运营 CLI 完成「发邀请 / 开课 / 选课 / 发额度」全流程。

**Architecture:** Control Plane 是唯一业务规则执行点。access token 用 HS256 JWT（短 TTL，仅服务端验签）；refresh token 用不透明随机串，只把 sha256 存库并在每次刷新时轮换，检测到已撤销的 token 被重放就撤销该用户整个 token 家族。邀请 token 同样只存哈希，明文仅在 CLI 输出一次。所有外部输入在边界处用 Zod 校验，环境变量在进程启动时校验并 fail fast。

**Tech Stack:** NestJS 11 · Prisma 6 + PostgreSQL 17 · jose 6（JWT）· @node-rs/argon2 2（密码哈希）· zod 4（校验）· nest-commander 3（运营 CLI）· Jest 30 + supertest

**上游依据：** `maic/docs/educationproject/2026-08-11-aivirteach-technical-architecture.html` 决策 #1、#2、#6，Linear `SRV-001` `SRV-002` `SRV-004` `SRV-005`。

## Global Constraints

- **仓库根目录**：`/Users/owenlee/Desktop/2025年/项目/aivirteach-server`（不在 `maic` 仓库内）
- **Node.js 24.18.0 / npm 11.16.0**；包管理器一律用 `npm`，不要引入 pnpm/yarn
- **在功能分支上工作**：仓库尚未初始化，Task 1 会 `git init -b main` 打一个基线提交，随后立刻切到 `feat/srv-004-self-signed-auth` 分支。**后续所有提交都落在这个分支上，绝不直接提交到 `main`**
- **不推送到 GitHub**：本计划只做本地 `git init`、建分支与本地提交，`git push` 一律不执行
- **端口隔离**：本机 5432/6379 已被 Homebrew 的 Postgres/Redis 占用，54321–54324 被另一项目的 Supabase 占用。本项目容器一律用 **Postgres 55432 / Redis 56379**，禁止使用默认端口
- **HTTP 对外形态由 server 自己定**：监听 **4000**（不是 Nest 默认的 3000），全局前缀 **`api/v1`**（即 `http://localhost:4000/api/v1/...`），并 `enableCors()` 走逗号分隔白名单。CORS 不能省——Tauri v2 的 webview 源是 `tauri://localhost`，跨源请求照样被拦
- **鉴权只有一种：自签 JWT**。不做 demo/无鉴权旁路。桌面端本来就要走 Keychain + refresh token（CLI-003），多一个模式开关等于多一个「上线前别忘了切」的坑
- **zod 版本为 4.x**：邮箱校验写 `z.email()` 而非 `z.string().email()`；错误从 `result.error.issues[]` 取，每项有 `.path`（数组）与 `.message`
- **jose 版本为 6.x**：密钥必须是 `Uint8Array`（用 `new TextEncoder().encode(secret)`），验签失败抛出的错误 `code` 为 `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`
- **argon2 用 `@node-rs/argon2`**（预编译 napi 包，无需本地编译）：`hash(password)` / `verify(hash, password)` 均为 async
- **绝不把明文 token 或密码写进日志、响应体以外的任何地方**；邀请码与 refresh token 落库只存 `sha256` hex
- **不可变风格**：不要原地修改传入的对象/数组，一律返回新对象
- **单元测试**（`src/**/*.spec.ts`，`npm test`）不得依赖数据库或网络；**集成测试**（`test/**/*.e2e-spec.ts`，`npm run test:e2e`）才允许连 Postgres
- **注释与用户可见文案用中文**，代码标识符用英文，与现有骨架风格一致（单引号、2 空格缩进、结尾分号）

---

## File Structure

实施完成后的目录（★ = 本计划新建，✎ = 修改，✗ = 删除）：

```
aivirteach-server/
├── docker-compose.yml                     ★ 本地 Postgres 55432 + Redis 56379
├── .env.example                           ✎ 换掉 Clerk/Stripe 变量
├── prisma/
│   ├── schema.prisma                      ✎ 七个模型
│   └── migrations/                        ★ prisma migrate 生成
├── src/
│   ├── main.ts                            ✎ 去掉 Stripe raw body 处理
│   ├── app.module.ts                      ✎ 换模块列表
│   ├── cli.ts                             ★ 运营 CLI 入口
│   ├── config/
│   │   ├── env.ts                         ★ 环境变量 Zod schema + loadEnv（纯函数）
│   │   ├── env.spec.ts                    ★
│   │   └── config.module.ts               ★ 全局 ENV provider
│   ├── common/
│   │   ├── zod-validation.pipe.ts         ★ 边界校验管道
│   │   └── zod-validation.pipe.spec.ts    ★
│   ├── prisma/                            （沿用现有，不改）
│   ├── health/health.controller.ts        ✎ 去掉 auth/billing 字段
│   ├── auth/
│   │   ├── tokens.ts                      ★ 签/验/哈希 纯函数
│   │   ├── tokens.spec.ts                 ★
│   │   ├── password.ts                    ★ argon2 封装
│   │   ├── password.spec.ts               ★
│   │   ├── auth.service.ts                ★ 登录/刷新/登出/接受邀请
│   │   ├── auth.service.spec.ts           ★
│   │   ├── auth.controller.ts             ✎ 重写为自签端点
│   │   ├── auth.schemas.ts                ★ 请求体 Zod schema
│   │   ├── jwt-auth.guard.ts              ★ 替代 clerk-auth.guard
│   │   ├── jwt-auth.guard.spec.ts         ★
│   │   ├── auth.module.ts                 ✎
│   │   └── clerk-auth.guard.ts            ✗
│   ├── admin/
│   │   ├── admin.service.ts               ★ 邀请/开课/选课/发额度（CLI 与未来 Admin API 共用）
│   │   ├── admin.service.spec.ts          ★
│   │   ├── admin.module.ts                ★
│   │   └── commands/
│   │       ├── invite.command.ts          ★
│   │       ├── course.command.ts          ★
│   │       ├── enroll.command.ts          ★
│   │       └── quota.command.ts           ★
│   └── billing/                           ✗ 整个目录删除
└── test/
    ├── auth.e2e-spec.ts                   ★ 需要 docker-compose 起来
    └── jest-e2e.json                      （沿用）
```

**边界说明：** `AdminService` 承载所有运营写操作，CLI command 类只负责解析参数和打印结果——这样将来 SRV-005 的 Admin API 接进来时直接复用同一个 service，不用重写业务规则。`tokens.ts` / `password.ts` 是纯函数模块，不依赖 Nest 容器，可以脱离框架单测。

---

## Task 1: 初始化 git 并移除 Clerk / Stripe

**Files:**
- Create: `.git/`（`git init`）
- Modify: `src/health/health.controller.ts`
- Modify: `src/main.ts`
- Modify: `src/app.module.ts`
- Modify: `src/auth/auth.module.ts`
- Modify: `.env.example`
- Delete: `src/auth/clerk-auth.guard.ts`, `src/auth/auth.controller.ts`, `src/billing/`（整个目录）
- Test: `src/health/health.controller.spec.ts`（新建）

**Interfaces:**
- Consumes: 现有 `PrismaService`（`src/prisma/prisma.service.ts`，已存在且带容错 `$connect`）
- Produces: `/health` 返回 `{ status: 'ok', database: 'up' | 'down' }`——后续任务的 e2e 冒烟检查依赖这个形状

- [ ] **Step 1: 初始化 git 仓库、打基线提交、切功能分支**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
git init -b main
git add -A
git commit -m "chore: 骨架基线（Clerk/Stripe 版本，即将移除）"
git checkout -b feat/srv-004-self-signed-auth
git branch --show-current
```

预期：首次提交成功，最后一行输出 `feat/srv-004-self-signed-auth`。

用 `git status --short` 确认工作区干净，并用下面这条确认 `.env` 没被提交进去（`.gitignore` 里已经有它）：

```bash
git ls-files --error-unmatch .env 2>&1 | head -1
```

预期输出 `error: pathspec '.env' did not match any file(s) known to git` —— 也就是 `.env` **没有**被 git 跟踪，这是对的。

> 本计划剩下的每一个 `git commit` 都发生在 `feat/srv-004-self-signed-auth` 上。每个任务提交前先跑 `git branch --show-current` 确认还在这个分支上，别不小心回到了 `main`。

- [ ] **Step 2: 写 health 的失败测试**

创建 `src/health/health.controller.spec.ts`：

```typescript
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  const buildController = async (queryRaw: () => Promise<unknown>) => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
    }).compile();
    return moduleRef.get(HealthController);
  };

  it('数据库可连通时返回 up，且不含 auth/billing 字段', async () => {
    const controller = await buildController(() => Promise.resolve([{ '?column?': 1 }]));

    await expect(controller.check()).resolves.toEqual({ status: 'ok', database: 'up' });
  });

  it('数据库不可连通时返回 down 而不是抛错', async () => {
    const controller = await buildController(() => Promise.reject(new Error('连不上')));

    await expect(controller.check()).resolves.toEqual({ status: 'ok', database: 'down' });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npm test -- health.controller.spec
```

预期：FAIL。第一个用例报 received 里多出 `auth` 和 `billing` 两个字段（现有实现仍在读 `CLERK_SECRET_KEY` / `STRIPE_SECRET_KEY`）。

- [ ] **Step 4: 改写 health controller**

把 `src/health/health.controller.ts` 整个替换为：

```typescript
import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up' | 'down' }> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    return { status: 'ok', database };
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npm test -- health.controller.spec
```

预期：PASS，2 passed。

- [ ] **Step 6: 删除 Clerk / Stripe 相关文件与依赖**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
rm -f src/auth/clerk-auth.guard.ts src/auth/auth.controller.ts
rm -rf src/billing
npm uninstall @clerk/backend stripe
```

- [ ] **Step 7: 把 auth.module.ts 改成空壳（Task 7 会填回来）**

`src/auth/auth.module.ts` 整个替换为：

```typescript
import { Module } from '@nestjs/common';

// 端点与 Guard 在 Task 7 接入，这里先保持模块存在但不导出任何东西。
@Module({})
export class AuthModule {}
```

- [ ] **Step 8: 从 app.module.ts 摘掉 BillingModule**

`src/app.module.ts` 整个替换为：

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [PrismaModule, AuthModule, HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

- [ ] **Step 9: 还原 main.ts 的 body parser，并对齐 client 契约**

Stripe webhook 是当初禁用全局 body parser 的唯一原因，现在恢复默认。同时补上三处 client 已经写死、server 必须迁就的配置：全局前缀 `api/v1`、端口 4000、CORS。`src/main.ts` 整个替换为：

```typescript
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // client（FrontEnd-v0）把 base URL 写死成 http://localhost:4000/api/v1，
  // 这三行是为了迁就它，不要按 Nest 默认值改回去。
  app.setGlobalPrefix('api/v1');

  // client 跑在 3001，与 server 不同源；不开 CORS 浏览器会直接拦掉所有请求。
  // 用逗号分隔的白名单而不是 origin: true，避免将来部署到公网时变成任意站点可读。
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AIVirTeach Control Plane')
    .setDescription('Closed Beta — Auth / Admin / Health')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
```

> `setGlobalPrefix` 不影响 Swagger 的挂载点，文档仍在 `http://localhost:4000/docs`。但**所有业务端点都会带上 `/api/v1`** ——Task 7 的 e2e 测试路径要写成 `/api/v1/auth/login` 而不是 `/auth/login`，别漏。

- [ ] **Step 10: 更新 .env.example**

`.env.example` 整个替换为：

```
# 数据库（docker-compose 起的 Postgres，端口 55432 避开本机已占用的 5432）
DATABASE_URL="postgresql://aivirteach:aivirteach@localhost:55432/aivirteach?schema=public"

# 鉴权 — 自签 JWT。至少 32 字符，生产环境从 secret manager 注入，绝不提交进仓库
# 本地生成：node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=

# token 生命周期
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
INVITATION_TTL_DAYS=7

# server 对外形态：端口 4000，全局前缀 api/v1
PORT=4000

# 允许跨源访问的来源，逗号分隔。Tauri v2 webview 的源是 tauri://localhost；
# 若同时要给本地网页调试用，追加 http://localhost:3001
CORS_ORIGINS=tauri://localhost,http://localhost:3001
```

- [ ] **Step 11: 确认全套检查通过**

```bash
npm run lint && npm run build && npm test
```

预期：lint 无 error；build 成功；jest 全绿（`app.controller.spec.ts` + `health.controller.spec.ts`）。

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "refactor: 移除 Clerk 与 Stripe，health 只报数据库状态"
```

---

## Task 2: 本地基础设施与环境变量校验

**Files:**
- Create: `docker-compose.yml`
- Create: `src/config/env.ts`
- Create: `src/config/env.spec.ts`
- Create: `src/config/config.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces:
  - `loadEnv(source?: NodeJS.ProcessEnv): Env` — 校验失败抛 `Error`，消息里逐行列出问题字段
  - `type Env = { DATABASE_URL: string; JWT_SECRET: string; ACCESS_TOKEN_TTL: string; REFRESH_TOKEN_TTL_DAYS: number; INVITATION_TTL_DAYS: number; PORT: number; CORS_ORIGINS: string }`
  - `ENV` 注入令牌（`Symbol`）与全局 `ConfigModule` — Task 4/6/8 用 `@Inject(ENV) env: Env` 取配置

- [ ] **Step 1: 写 loadEnv 的失败测试**

创建 `src/config/env.spec.ts`：

```typescript
import { loadEnv } from './env';

const validSource = {
  DATABASE_URL: 'postgresql://u:p@localhost:55432/db',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('填齐必填项时套用默认值', () => {
    expect(loadEnv(validSource)).toEqual({
      DATABASE_URL: 'postgresql://u:p@localhost:55432/db',
      JWT_SECRET: 'x'.repeat(32),
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL_DAYS: 30,
      INVITATION_TTL_DAYS: 7,
      PORT: 4000,
      CORS_ORIGINS: 'tauri://localhost',
    });
  });

  it('把数字型变量从字符串强制转换', () => {
    const env = loadEnv({ ...validSource, PORT: '4100', REFRESH_TOKEN_TTL_DAYS: '7' });

    expect(env.PORT).toBe(4100);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7);
  });

  it('JWT_SECRET 太短时抛错并指名字段', () => {
    expect(() => loadEnv({ ...validSource, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('缺少 DATABASE_URL 时抛错并指名字段', () => {
    expect(() => loadEnv({ JWT_SECRET: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- config/env.spec
```

预期：FAIL，`Cannot find module './env'`。

- [ ] **Step 3: 实现 loadEnv**

创建 `src/config/env.ts`：

```typescript
import { z } from 'zod';

// 在进程启动时一次性校验，缺配置就直接崩，不要等到第一个请求进来才发现。
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符'),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORT: z.coerce.number().int().positive().default(4000),
  // Tauri v2 webview 的源；本地网页调试再往白名单里追加
  CORS_ORIGINS: z.string().min(1).default('tauri://localhost'),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`环境变量校验失败：\n${detail}`);
  }

  return parsed.data;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test -- config/env.spec
```

预期：PASS，4 passed。

- [ ] **Step 5: 建立全局 ConfigModule**

创建 `src/config/config.module.ts`：

```typescript
import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
```

- [ ] **Step 6: 接进 app.module.ts**

修改 `src/app.module.ts`，加入 import 并放在 imports 数组第一位：

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

- [ ] **Step 7: 建立 docker-compose.yml**

创建 `docker-compose.yml`：

```yaml
# 本机 5432/6379 已被 Homebrew 服务占用，54321-54324 被另一项目的 Supabase 占用，
# 因此本项目固定用 55432 / 56379，避免互相覆盖。
services:
  postgres:
    image: postgres:17-alpine
    container_name: aivirteach-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: aivirteach
      POSTGRES_PASSWORD: aivirteach
      POSTGRES_DB: aivirteach
    ports:
      - '55432:5432'
    volumes:
      - aivirteach-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U aivirteach -d aivirteach']
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: aivirteach-redis
    restart: unless-stopped
    ports:
      - '56379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  aivirteach-pgdata:
```

Redis 本计划还用不上（BullMQ 是计划 B 的事），先起好省得计划 B 再改编排文件。

- [ ] **Step 8: 起容器并确认健康**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
docker compose up -d
sleep 8
docker compose ps
```

预期：两个服务 STATUS 均为 `Up ... (healthy)`。若 55432 报端口冲突，说明本机还有别的东西占了这个端口，先 `lsof -i:55432` 查明再处理，**不要**改回 5432。

- [ ] **Step 9: 写本地 .env 并确认应用能起**

```bash
cp .env.example .env
node -e "const fs=require('node:fs');const s=require('node:crypto').randomBytes(48).toString('base64url');fs.writeFileSync('.env',fs.readFileSync('.env','utf8').replace(/^JWT_SECRET=$/m,'JWT_SECRET='+s));"
grep -c '^JWT_SECRET=.\{32,\}$' .env
```

预期最后一行输出 `1`（密钥已写入且长度够）。`.env` 已在 `.gitignore` 里，不会被提交。

- [ ] **Step 10: 运行完整检查并提交**

```bash
npm run lint && npm run build && npm test
git add -A
git commit -m "feat: 加入 docker-compose 本地基建与启动期环境变量校验"
```

---

## Task 3: Prisma 数据模型与首次迁移

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/`（由 `prisma migrate dev` 生成）
- Modify: `package.json`（加 `db:migrate` / `db:reset` 脚本）

**Interfaces:**
- Produces: Prisma Client 类型 `User` `Invitation` `RefreshToken` `Course` `Enrollment` `QuotaGrant` 与枚举 `UserStatus`。后续任务通过 `PrismaService` 上的 `user` / `invitation` / `refreshToken` / `course` / `enrollment` / `quotaGrant` 委托访问。
- 关键字段约定（后续任务直接依赖，勿改名）：
  - `User.passwordHash: string | null` — `null` 表示邀请尚未被接受
  - `User.status: 'INVITED' | 'ACTIVE' | 'SUSPENDED'`
  - `Invitation.tokenHash` / `RefreshToken.tokenHash` — 均为明文的 sha256 hex，`@unique`
  - `RefreshToken.replacedBy: string | null` — 轮换链，用于重放检测

- [ ] **Step 1: 改写 schema.prisma**

`prisma/schema.prisma` 整个替换为：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserStatus {
  INVITED
  ACTIVE
  SUSPENDED
}

model User {
  id           String     @id @default(cuid())
  email        String     @unique
  displayName  String?
  // 邀请未被接受时为 null；接受邀请设置密码后才有值。
  passwordHash String?
  status       UserStatus @default(INVITED)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  invitations   Invitation[]
  refreshTokens RefreshToken[]
  enrollments   Enrollment[]
  quotaGrants   QuotaGrant[]
}

model Invitation {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  // sha256(明文邀请码)。明文只在运营 CLI 输出一次，不落库。
  tokenHash  String    @unique
  expiresAt  DateTime
  acceptedAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([userId])
}

model RefreshToken {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique
  expiresAt  DateTime
  revokedAt  DateTime?
  // 指向本 token 轮换后产生的新 token id；已撤销且有该值的 token 被重放时，撤销整个家族。
  replacedBy String?
  createdAt  DateTime  @default(now())

  @@index([userId])
}

model Course {
  id          String    @id @default(cuid())
  slug        String    @unique
  title       String
  publishedAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  enrollments Enrollment[]
}

model Enrollment {
  id        String   @id @default(cuid())
  userId    String
  courseId  String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  course    Course   @relation(fields: [courseId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@unique([userId, courseId])
  @@index([courseId])
}

model QuotaGrant {
  id             String    @id @default(cuid())
  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  minutesGranted Int
  minutesUsed    Int       @default(0)
  expiresAt      DateTime?
  createdAt      DateTime  @default(now())

  @@index([userId])
}
```

- [ ] **Step 2: 生成并应用首次迁移**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
npx prisma migrate dev --name init_closed_beta_schema
```

预期：输出 `Your database is now in sync with your schema.` 并在 `prisma/migrations/` 下生成一个带时间戳的目录。若报连不上数据库，回到 Task 2 Step 8 确认容器 healthy 且 `.env` 里 `DATABASE_URL` 端口是 55432。

- [ ] **Step 3: 加数据库脚本到 package.json**

在 `package.json` 的 `scripts` 里追加三行（放在 `"test:e2e"` 之后）：

```json
    "db:up": "docker compose up -d",
    "db:migrate": "prisma migrate dev",
    "db:reset": "prisma migrate reset --force"
```

- [ ] **Step 4: 写一个集成测试验证 schema 真的能用**

创建 `test/schema.e2e-spec.ts`：

```typescript
import { PrismaClient } from '@prisma/client';

// 需要 docker compose up -d 且已执行 prisma migrate。
describe('数据库 schema', () => {
  const prisma = new PrismaClient();
  const email = `schema-${Date.now()}@example.com`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('新建用户默认是 INVITED 且没有密码哈希', async () => {
    const user = await prisma.user.create({ data: { email } });

    expect(user.status).toBe('INVITED');
    expect(user.passwordHash).toBeNull();
  });

  it('级联删除会带走用户的邀请记录', async () => {
    const user = await prisma.user.create({
      data: {
        email: `cascade-${Date.now()}@example.com`,
        invitations: {
          create: { tokenHash: `hash-${Date.now()}`, expiresAt: new Date(Date.now() + 86_400_000) },
        },
      },
      include: { invitations: true },
    });
    expect(user.invitations).toHaveLength(1);

    await prisma.user.delete({ where: { id: user.id } });

    await expect(
      prisma.invitation.findUnique({ where: { id: user.invitations[0].id } }),
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 5: 运行集成测试确认通过**

```bash
npm run test:e2e -- schema.e2e-spec
```

预期：PASS，2 passed。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 加入封测核心数据模型与首次迁移"
```

---

## Task 4: 密码哈希与 token 纯函数

**Files:**
- Create: `src/auth/password.ts`, `src/auth/password.spec.ts`
- Create: `src/auth/tokens.ts`, `src/auth/tokens.spec.ts`
- Modify: `package.json`（新增依赖）

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(hash: string, plain: string): Promise<boolean>` — 哈希串损坏时返回 `false`，不抛错
  - `signAccessToken(claims: AccessTokenClaims, secret: string, ttl: string): Promise<string>`
  - `verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims>` — 失败抛 `InvalidTokenError`
  - `interface AccessTokenClaims { sub: string; email: string }`
  - `class InvalidTokenError extends Error`
  - `generateOpaqueToken(): string` — 32 字节随机，base64url
  - `hashOpaqueToken(token: string): string` — sha256 hex

- [ ] **Step 1: 安装依赖**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
npm install jose@^6 @node-rs/argon2@^2 zod@^4
```

- [ ] **Step 2: 写 password 的失败测试**

创建 `src/auth/password.spec.ts`：

```typescript
import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('哈希结果不等于明文，且用的是 argon2id', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).not.toContain('correct horse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('同一个密码两次哈希结果不同（加盐）', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);

    expect(a).not.toBe(b);
  });

  it('正确密码验证通过，错误密码不通过', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('哈希串损坏时返回 false 而不是抛错', async () => {
    await expect(verifyPassword('not-a-valid-hash', 'anything')).resolves.toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npm test -- auth/password.spec
```

预期：FAIL，`Cannot find module './password'`。

- [ ] **Step 4: 实现 password.ts**

创建 `src/auth/password.ts`：

```typescript
import { hash, verify } from '@node-rs/argon2';

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

// 哈希串可能因数据损坏而无法解析——这属于「验证失败」，不该让调用方去 try/catch。
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npm test -- auth/password.spec
```

预期：PASS，4 passed。

- [ ] **Step 6: 写 tokens 的失败测试**

创建 `src/auth/tokens.spec.ts`：

```typescript
import {
  InvalidTokenError,
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const claims = { sub: 'user_123', email: 'learner@example.com' };

describe('access token', () => {
  it('签发后能用同一密钥验回原始 claims', async () => {
    const token = await signAccessToken(claims, SECRET, '15m');

    await expect(verifyAccessToken(token, SECRET)).resolves.toEqual(claims);
  });

  it('换一个密钥验签会抛 InvalidTokenError', async () => {
    const token = await signAccessToken(claims, SECRET, '15m');

    await expect(verifyAccessToken(token, OTHER_SECRET)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('已过期的 token 会抛 InvalidTokenError', async () => {
    const token = await signAccessToken(claims, SECRET, '0s');

    await expect(verifyAccessToken(token, SECRET)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('乱码字符串会抛 InvalidTokenError 而不是别的异常', async () => {
    await expect(verifyAccessToken('not.a.jwt', SECRET)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('opaque token', () => {
  it('每次生成都不同，且长度足够', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('哈希是确定的 64 位 hex，且不等于明文', () => {
    const token = generateOpaqueToken();
    const hashed = hashOpaqueToken(token);

    expect(hashed).toBe(hashOpaqueToken(token));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toBe(token);
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

```bash
npm test -- auth/tokens.spec
```

预期：FAIL，`Cannot find module './tokens'`。

- [ ] **Step 8: 实现 tokens.ts**

创建 `src/auth/tokens.ts`：

```typescript
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const TOKEN_ISSUER = 'aivirteach';
export const TOKEN_AUDIENCE = 'aivirteach-client';

export interface AccessTokenClaims {
  sub: string;
  email: string;
}

export class InvalidTokenError extends Error {
  constructor(message = 'token 无效或已过期') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

// jose 要求密钥是 Uint8Array，不能直接传字符串。
const toKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttl: string,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setExpirationTime(ttl)
    .sign(toKey(secret));
}

// 所有失败原因（签名不符、过期、格式错误）统一成 InvalidTokenError，
// 避免把 jose 的内部错误类型泄露给上层，也避免用错误信息区分「无此用户」和「密码错」。
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, toKey(secret), {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new InvalidTokenError('token 缺少必要字段');
    }

    return { sub: payload.sub, email: payload.email };
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      throw error;
    }
    throw new InvalidTokenError();
  }
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 9: 运行测试确认通过**

```bash
npm test -- auth/tokens.spec
```

预期：PASS，6 passed。

- [ ] **Step 10: 提交**

```bash
npm run lint && npm run build && npm test
git add -A
git commit -m "feat: 加入密码哈希与 JWT/不透明 token 纯函数"
```

---

## Task 5: AuthService — 接受邀请 / 登录 / 刷新 / 登出

**Files:**
- Create: `src/auth/auth.service.ts`, `src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `ENV` / `Env`；Task 3 的 Prisma 模型；Task 4 的 `hashPassword` `verifyPassword` `signAccessToken` `generateOpaqueToken` `hashOpaqueToken`
- Produces:
  - `interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }`
  - `AuthService.acceptInvitation(token: string, password: string): Promise<TokenPair>`
  - `AuthService.login(email: string, password: string): Promise<TokenPair>`
  - `AuthService.refresh(refreshToken: string): Promise<TokenPair>`
  - `AuthService.logout(refreshToken: string): Promise<void>`
  - 全部失败路径抛 `UnauthorizedException`，消息统一为 `凭证无效`，**不区分**「用户不存在」「密码错」「已停用」——避免账号枚举

- [ ] **Step 1: 写 AuthService 的失败测试**

创建 `src/auth/auth.service.spec.ts`：

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { hashOpaqueToken, verifyAccessToken } from './tokens';

const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: 'a'.repeat(48),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
};

const future = () => new Date(Date.now() + 3_600_000);
const past = () => new Date(Date.now() - 3_600_000);

type PrismaStub = {
  user: { findUnique: jest.Mock; update: jest.Mock };
  invitation: { findUnique: jest.Mock; update: jest.Mock };
  refreshToken: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

const buildPrisma = (): PrismaStub => ({
  user: { findUnique: jest.fn(), update: jest.fn() },
  invitation: { findUnique: jest.fn(), update: jest.fn() },
  refreshToken: {
    findUnique: jest.fn(),
    create: jest.fn().mockImplementation(({ data }: { data: { tokenHash: string } }) =>
      Promise.resolve({ id: `rt_${data.tokenHash.slice(0, 6)}`, ...data }),
    ),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
});

const buildService = async (prisma: PrismaStub) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
    ],
  }).compile();
  return moduleRef.get(AuthService);
};

describe('AuthService.login', () => {
  it('凭证正确时返回可验签的 access token 和不透明 refresh token', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'ACTIVE',
    });
    const service = await buildService(prisma);

    const pair = await service.login('learner@example.com', 'correct-password');

    await expect(verifyAccessToken(pair.accessToken, ENV_STUB.JWT_SECRET)).resolves.toEqual({
      sub: 'user_1',
      email: 'learner@example.com',
    });
    expect(pair.refreshToken).not.toContain('.');
    // 落库的必须是哈希，不能是明文
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenHash: hashOpaqueToken(pair.refreshToken) }),
      }),
    );
  });

  it('密码错误时抛 UnauthorizedException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'ACTIVE',
    });
    const service = await buildService(prisma);

    await expect(service.login('learner@example.com', 'wrong')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('用户不存在与密码错误的报错信息完全一致（防账号枚举）', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.login('nobody@example.com', 'whatever')).rejects.toThrow('凭证无效');
  });

  it('用户被停用时拒绝登录', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'SUSPENDED',
    });
    const service = await buildService(prisma);

    await expect(service.login('learner@example.com', 'correct-password')).rejects.toThrow(
      '凭证无效',
    );
  });
});

describe('AuthService.acceptInvitation', () => {
  it('有效邀请码会设置密码、激活账号并发 token', async () => {
    const prisma = buildPrisma();
    prisma.invitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      expiresAt: future(),
      acceptedAt: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'INVITED' },
    });
    prisma.user.update.mockResolvedValue({});
    const service = await buildService(prisma);

    const pair = await service.acceptInvitation('plain-invite-token', 'new-password-123');

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(prisma.invitation.update).toHaveBeenCalled();
    await expect(verifyAccessToken(pair.accessToken, ENV_STUB.JWT_SECRET)).resolves.toEqual({
      sub: 'user_1',
      email: 'learner@example.com',
    });
  });

  it('邀请码已被用过时拒绝', async () => {
    const prisma = buildPrisma();
    prisma.invitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      expiresAt: future(),
      acceptedAt: new Date(),
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const service = await buildService(prisma);

    await expect(service.acceptInvitation('used-token', 'pw-12345678')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('邀请码过期时拒绝', async () => {
    const prisma = buildPrisma();
    prisma.invitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      expiresAt: past(),
      acceptedAt: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'INVITED' },
    });
    const service = await buildService(prisma);

    await expect(service.acceptInvitation('expired', 'pw-12345678')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService.refresh', () => {
  it('有效 refresh token 会轮换：旧的被撤销并指向新的', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt_old',
      userId: 'user_1',
      expiresAt: future(),
      revokedAt: null,
      replacedBy: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const service = await buildService(prisma);

    const pair = await service.refresh('old-plain-token');

    expect(pair.refreshToken).toBeDefined();
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt_old' },
        data: expect.objectContaining({ replacedBy: expect.any(String) }),
      }),
    );
  });

  it('重放已撤销的 token 会撤销该用户整个 token 家族', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt_old',
      userId: 'user_1',
      expiresAt: future(),
      revokedAt: new Date(),
      replacedBy: 'rt_new',
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const service = await buildService(prisma);

    await expect(service.refresh('replayed-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1' }) }),
    );
  });

  it('不存在的 refresh token 被拒绝', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.refresh('nonexistent')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.logout', () => {
  it('撤销指定的 refresh token', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt_1',
      userId: 'user_1',
      expiresAt: future(),
      revokedAt: null,
      replacedBy: null,
      user: { id: 'user_1', email: 'learner@example.com', status: 'ACTIVE' },
    });
    const service = await buildService(prisma);

    await service.logout('plain-token');

    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt_1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it('登出一个不存在的 token 不报错（幂等）', async () => {
    const prisma = buildPrisma();
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.logout('nonexistent')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- auth/auth.service.spec
```

预期：FAIL，`Cannot find module './auth.service'`。

- [ ] **Step 3: 实现 AuthService**

创建 `src/auth/auth.service.ts`：

```typescript
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { generateOpaqueToken, hashOpaqueToken, signAccessToken } from './tokens';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// 所有鉴权失败对外都是同一句话，防止用报错差异枚举账号。
const DENIED = '凭证无效';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async acceptInvitation(token: string, password: string): Promise<TokenPair> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { user: true },
    });

    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      throw new UnauthorizedException(DENIED);
    }

    const passwordHash = await hashPassword(password);
    await this.prisma.user.update({
      where: { id: invitation.userId },
      data: { passwordHash, status: 'ACTIVE' },
    });
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    return this.issueTokens(invitation.user.id, invitation.user.email);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user?.passwordHash || user.status !== 'ACTIVE') {
      throw new UnauthorizedException(DENIED);
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new UnauthorizedException(DENIED);
    }

    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException(DENIED);
    }

    // 已经轮换过的 token 又被拿来用 —— 说明泄露了，把这个用户所有未撤销的 token 一并作废。
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException(DENIED);
    }

    if (stored.expiresAt <= new Date() || stored.user.status !== 'ACTIVE') {
      throw new UnauthorizedException(DENIED);
    }

    const { pair, refreshTokenId } = await this.issueTokensWithId(
      stored.user.id,
      stored.user.email,
    );

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: refreshTokenId },
    });

    return pair;
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
      include: { user: true },
    });

    // 登出必须幂等：token 不存在或已撤销都当作成功。
    if (!stored || stored.revokedAt) {
      return;
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(userId: string, email: string): Promise<TokenPair> {
    const { pair } = await this.issueTokensWithId(userId, email);
    return pair;
  }

  // refresh 需要知道新建 token 的 id 才能写轮换链，所以 create 的返回值必须传回去，
  // 不要事后再按 tokenHash 查一次。
  private async issueTokensWithId(
    userId: string,
    email: string,
  ): Promise<{ pair: TokenPair; refreshTokenId: string }> {
    const accessToken = await signAccessToken(
      { sub: userId, email },
      this.env.JWT_SECRET,
      this.env.ACCESS_TOKEN_TTL,
    );

    const refreshToken = generateOpaqueToken();
    const created = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      },
    });

    return {
      pair: {
        accessToken,
        refreshToken,
        expiresIn: this.env.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
      },
      refreshTokenId: created.id,
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test -- auth/auth.service.spec
```

预期：PASS，12 passed。

`refresh` 只查一次 `findUnique`（新 token 的 id 直接来自 `create` 的返回值），所以 stub 里那个单一 `findUnique` mock 够用，不需要 `mockResolvedValueOnce` 链。

- [ ] **Step 5: 提交**

```bash
npm run lint && npm run build && npm test
git add -A
git commit -m "feat: 实现自签鉴权服务（邀请/登录/轮换刷新/登出）"
```

---

## Task 6: JwtAuthGuard 与 Zod 校验管道

**Files:**
- Create: `src/common/zod-validation.pipe.ts`, `src/common/zod-validation.pipe.spec.ts`
- Create: `src/auth/jwt-auth.guard.ts`, `src/auth/jwt-auth.guard.spec.ts`

**Interfaces:**
- Produces:
  - `class ZodValidationPipe<T> implements PipeTransform` — 构造参数 `schema: ZodType<T>`，失败抛 `BadRequestException`，body 形如 `{ message, issues: [{ path, message }] }`
  - `class JwtAuthGuard implements CanActivate` — 通过后在 request 上挂 `auth: { userId: string; email: string }`
  - `type AuthenticatedRequest = Request & { auth?: { userId: string; email: string } }`

- [ ] **Step 1: 写校验管道的失败测试**

创建 `src/common/zod-validation.pipe.spec.ts`：

```typescript
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({ email: z.email(), password: z.string().min(8) });

describe('ZodValidationPipe', () => {
  it('合法输入原样返回解析结果', () => {
    const pipe = new ZodValidationPipe(schema);

    expect(pipe.transform({ email: 'a@b.com', password: '12345678' })).toEqual({
      email: 'a@b.com',
      password: '12345678',
    });
  });

  it('非法输入抛 BadRequestException 并逐项列出问题字段', () => {
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ email: 'nope', password: 'x' });
      fail('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        issues: { path: string; message: string }[];
      };
      expect(response.issues.map((i) => i.path).sort()).toEqual(['email', 'password']);
    }
  });

  it('剥掉 schema 未声明的多余字段', () => {
    const pipe = new ZodValidationPipe(schema);

    expect(pipe.transform({ email: 'a@b.com', password: '12345678', isAdmin: true })).toEqual({
      email: 'a@b.com',
      password: '12345678',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- zod-validation.pipe.spec
```

预期：FAIL，`Cannot find module './zod-validation.pipe'`。

- [ ] **Step 3: 实现校验管道**

创建 `src/common/zod-validation.pipe.ts`：

```typescript
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

// 系统边界统一在这里校验：外部输入一律不可信，解析成功才允许进入业务层。
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: '请求参数校验失败',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test -- zod-validation.pipe.spec
```

预期：PASS，3 passed。

- [ ] **Step 5: 写 Guard 的失败测试**

创建 `src/auth/jwt-auth.guard.spec.ts`：

```typescript
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ENV } from '../config/env';
import { JwtAuthGuard } from './jwt-auth.guard';
import { signAccessToken } from './tokens';

const SECRET = 'a'.repeat(48);
const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: SECRET,
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
};

const contextWith = (headers: Record<string, string>) => {
  const request: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    __request: request,
  } as unknown as ExecutionContext & { __request: Record<string, unknown> };
};

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(ENV_STUB);

  it('合法 token 放行并把身份挂到 request.auth', async () => {
    const token = await signAccessToken({ sub: 'user_1', email: 'a@b.com' }, SECRET, '15m');
    const context = contextWith({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(context.__request.auth).toEqual({ userId: 'user_1', email: 'a@b.com' });
  });

  it('缺 Authorization 头时拒绝', async () => {
    await expect(guard.canActivate(contextWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('不是 Bearer 格式时拒绝', async () => {
    const context = contextWith({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('签名不符的 token 被拒绝', async () => {
    const token = await signAccessToken({ sub: 'user_1', email: 'a@b.com' }, 'b'.repeat(48), '15m');
    const context = contextWith({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

```bash
npm test -- jwt-auth.guard.spec
```

预期：FAIL，`Cannot find module './jwt-auth.guard'`。

- [ ] **Step 7: 实现 Guard**

创建 `src/auth/jwt-auth.guard.ts`：

```typescript
import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';
import { verifyAccessToken } from './tokens';

export type AuthenticatedRequest = Request & {
  auth?: { userId: string; email: string };
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Bearer token');
    }

    try {
      const claims = await verifyAccessToken(header.slice(7), this.env.JWT_SECRET);
      request.auth = { userId: claims.sub, email: claims.email };
      return true;
    } catch {
      throw new UnauthorizedException('token 无效或已过期');
    }
  }
}
```

- [ ] **Step 8: 运行测试确认通过**

```bash
npm test -- jwt-auth.guard.spec
```

预期：PASS，4 passed。

- [ ] **Step 9: 提交**

```bash
npm run lint && npm run build && npm test
git add -A
git commit -m "feat: 加入 Zod 边界校验管道与 JWT Guard"
```

---

## Task 7: Auth 端点与端到端验证

**Files:**
- Create: `src/auth/auth.schemas.ts`
- Create: `src/auth/auth.controller.ts`
- Modify: `src/auth/auth.module.ts`
- Create: `test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 5 `AuthService`，Task 6 `ZodValidationPipe` `JwtAuthGuard` `AuthenticatedRequest`
- Produces: HTTP 契约（计划 B 与 client CLI-003 依赖这些路径与响应体）。controller 里的路径写 `auth/...`，`setGlobalPrefix('api/v1')` 会自动补前缀，**测试与 curl 必须写全路径**：
  - `POST /api/v1/auth/invitations/accept` body `{ token, password }` → `200 { accessToken, refreshToken, expiresIn }`
  - `POST /api/v1/auth/login` body `{ email, password }` → `200 TokenPair`
  - `POST /api/v1/auth/refresh` body `{ refreshToken }` → `200 TokenPair`
  - `POST /api/v1/auth/logout` body `{ refreshToken }` → `204`
  - `GET /api/v1/auth/me`（需 Bearer）→ `200 { userId, email }`

- [ ] **Step 1: 定义请求体 schema**

创建 `src/auth/auth.schemas.ts`：

```typescript
import { z } from 'zod';

// 密码下限 8 位，与 acceptInvitation 的实际写入路径保持一致。
export const AcceptInvitationSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, '密码至少 8 位'),
});

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
```

- [ ] **Step 2: 写 e2e 失败测试**

创建 `test/auth.e2e-spec.ts`：

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { generateOpaqueToken, hashOpaqueToken } from '../src/auth/tokens';

// 需要 docker compose up -d 且已执行 prisma migrate。
describe('Auth 端到端', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const email = `e2e-${Date.now()}@example.com`;
  const inviteToken = generateOpaqueToken();
  const password = 'closed-beta-2026';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await prisma.user.create({
      data: {
        email,
        invitations: {
          create: {
            tokenHash: hashOpaqueToken(inviteToken),
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
    await app.close();
  });

  it('接受邀请 → 登录 → 访问 /auth/me → 刷新 → 登出 全流程', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/auth/invitations/accept')
      .send({ token: inviteToken, password })
      .expect(200);
    expect(accepted.body.accessToken).toBeDefined();

    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(email);

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: loggedIn.body.refreshToken })
      .expect(200);
    expect(refreshed.body.refreshToken).not.toBe(loggedIn.body.refreshToken);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(204);
  });

  it('重放已轮换的 refresh token 被拒绝', async () => {
    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: loggedIn.body.refreshToken })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: loggedIn.body.refreshToken })
      .expect(401);
  });

  it('无 token 访问 /auth/me 返回 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('邮箱格式错误返回 400 并指出字段', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'whatever' })
      .expect(400);

    expect(response.body.issues.map((i: { path: string }) => i.path)).toContain('email');
  });
});
```

- [ ] **Step 3: 运行 e2e 确认失败**

```bash
npm run test:e2e -- auth.e2e-spec
```

预期：FAIL，所有 `/api/v1/auth/*` 路由 404（controller 还没写）。

- [ ] **Step 4: 实现 AuthController**

创建 `src/auth/auth.controller.ts`：

```typescript
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService, type TokenPair } from './auth.service';
import {
  AcceptInvitationSchema,
  LoginSchema,
  RefreshSchema,
  type AcceptInvitationInput,
  type LoginInput,
  type RefreshInput,
} from './auth.schemas';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('invitations/accept')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(AcceptInvitationSchema))
  acceptInvitation(@Body() body: AcceptInvitationInput): Promise<TokenPair> {
    return this.authService.acceptInvitation(body.token, body.password);
  }

  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  login(@Body() body: LoginInput): Promise<TokenPair> {
    return this.authService.login(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  refresh(@Body() body: RefreshInput): Promise<TokenPair> {
    return this.authService.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  logout(@Body() body: RefreshInput): Promise<void> {
    return this.authService.logout(body.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  me(@Req() request: AuthenticatedRequest): { userId: string; email: string } {
    // Guard 通过后 auth 必然存在。
    return request.auth!;
  }
}
```

- [ ] **Step 5: 接线 AuthModule**

`src/auth/auth.module.ts` 整个替换为：

```typescript
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
```

- [ ] **Step 6: 运行 e2e 确认通过**

```bash
docker compose up -d
npm run test:e2e -- auth.e2e-spec
```

预期：PASS，4 passed。

- [ ] **Step 7: 人工确认 Swagger 已列出新端点**

```bash
npm run start:dev &
sleep 6
curl -s http://localhost:4000/docs-json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s).paths).sort().join('\n')))"
kill %1
```

预期输出是 6 条带前缀的路径：`/api/v1/auth/invitations/accept`、`/api/v1/auth/login`、`/api/v1/auth/logout`、`/api/v1/auth/me`、`/api/v1/auth/refresh`、`/api/v1/health`。

> `SwaggerModule.createDocument` 默认会把 `setGlobalPrefix` 的前缀算进路径里。如果这里输出的是不带 `/api/v1` 的裸路径，说明这版 Nest 的默认值不是这样——那就在 `createDocument` 第三个参数显式传 `{ ignoreGlobalPrefix: false }`。**不要改 `setGlobalPrefix`**，那个是 client 契约要求的，Swagger 只是展示层。真正以 e2e 测试跑通为准。

- [ ] **Step 8: 提交**

```bash
npm run lint && npm run build && npm test
git add -A
git commit -m "feat: 加入自签鉴权 HTTP 端点与端到端测试"
```

---

## Task 8: 运营 CLI

**Files:**
- Create: `src/admin/admin.service.ts`, `src/admin/admin.service.spec.ts`
- Create: `src/admin/admin.module.ts`
- Create: `src/admin/commands/invite.command.ts`
- Create: `src/admin/commands/course.command.ts`
- Create: `src/admin/commands/enroll.command.ts`
- Create: `src/admin/commands/quota.command.ts`
- Create: `src/cli.ts`
- Modify: `src/app.module.ts`（加入 AdminModule）
- Modify: `package.json`（加 `cli` 脚本）

**Interfaces:**
- Consumes: Task 2 `ENV`，Task 3 Prisma 模型，Task 4 `generateOpaqueToken` `hashOpaqueToken`
- Produces:
  - `AdminService.inviteUser(email: string): Promise<{ userId: string; invitationToken: string; expiresAt: Date }>` — `invitationToken` 是明文，**只在这一次返回**
  - `AdminService.createCourse(slug: string, title: string): Promise<Course>`
  - `AdminService.publishCourse(slug: string): Promise<Course>`
  - `AdminService.enrollUser(email: string, courseSlug: string): Promise<Enrollment>`
  - `AdminService.grantQuota(email: string, minutes: number): Promise<QuotaGrant>`
  - 找不到实体一律抛 `NotFoundException`

- [ ] **Step 1: 安装 nest-commander**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
npm install nest-commander@^3
```

- [ ] **Step 2: 写 AdminService 的失败测试**

创建 `src/admin/admin.service.spec.ts`：

```typescript
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { hashOpaqueToken } from '../auth/tokens';
import { AdminService } from './admin.service';

const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: 'a'.repeat(48),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
};

const buildPrisma = () => ({
  user: { upsert: jest.fn(), findUnique: jest.fn() },
  invitation: { create: jest.fn().mockResolvedValue({ id: 'inv_1' }) },
  course: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  enrollment: { create: jest.fn() },
  quotaGrant: { create: jest.fn() },
});

const buildService = async (prisma: ReturnType<typeof buildPrisma>) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
    ],
  }).compile();
  return moduleRef.get(AdminService);
};

describe('AdminService.inviteUser', () => {
  it('返回明文邀请码，但落库的是它的哈希', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({ id: 'user_1', email: 'new@example.com' });
    const service = await buildService(prisma);

    const result = await service.inviteUser('new@example.com');

    expect(result.invitationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          tokenHash: hashOpaqueToken(result.invitationToken),
        }),
      }),
    );
  });

  it('重复邀请同一邮箱不会新建用户（upsert）', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({ id: 'user_1', email: 'dup@example.com' });
    const service = await buildService(prisma);

    await service.inviteUser('dup@example.com');

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'dup@example.com' } }),
    );
  });
});

describe('AdminService 其余运营操作', () => {
  it('给不存在的用户发额度抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.grantQuota('ghost@example.com', 120)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('给不存在的课程选课抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    prisma.course.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.enrollUser('a@b.com', 'no-such-course')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('发布课程时写入 publishedAt', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.course.update.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    const service = await buildService(prisma);

    await service.publishCourse('n8n');

    expect(prisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'course_1' },
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npm test -- admin/admin.service.spec
```

预期：FAIL，`Cannot find module './admin.service'`。

- [ ] **Step 4: 实现 AdminService**

创建 `src/admin/admin.service.ts`：

```typescript
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, Enrollment, QuotaGrant } from '@prisma/client';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InviteResult {
  userId: string;
  email: string;
  invitationToken: string;
  expiresAt: Date;
}

// 封测期所有「开通」动作都走这里。将来 Admin API 接进来时复用同一套规则，
// 不要在 controller 里另写一份。
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async inviteUser(email: string): Promise<InviteResult> {
    const user = await this.prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });

    const invitationToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.env.INVITATION_TTL_DAYS * DAY_MS);

    await this.prisma.invitation.create({
      data: { userId: user.id, tokenHash: hashOpaqueToken(invitationToken), expiresAt },
    });

    // 明文只在这里返回一次，之后无法再取回。
    return { userId: user.id, email: user.email, invitationToken, expiresAt };
  }

  async createCourse(slug: string, title: string): Promise<Course> {
    return this.prisma.course.create({ data: { slug, title } });
  }

  async publishCourse(slug: string): Promise<Course> {
    const course = await this.requireCourse(slug);

    return this.prisma.course.update({
      where: { id: course.id },
      data: { publishedAt: new Date() },
    });
  }

  async enrollUser(email: string, courseSlug: string): Promise<Enrollment> {
    const user = await this.requireUser(email);
    const course = await this.requireCourse(courseSlug);

    return this.prisma.enrollment.create({ data: { userId: user.id, courseId: course.id } });
  }

  async grantQuota(email: string, minutes: number): Promise<QuotaGrant> {
    const user = await this.requireUser(email);

    return this.prisma.quotaGrant.create({ data: { userId: user.id, minutesGranted: minutes } });
  }

  private async requireUser(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException(`找不到用户：${email}`);
    }
    return user;
  }

  private async requireCourse(slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) {
      throw new NotFoundException(`找不到课程：${slug}`);
    }
    return course;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npm test -- admin/admin.service.spec
```

预期：PASS，5 passed。

- [ ] **Step 6: 实现四个 CLI command**

创建 `src/admin/commands/invite.command.ts`：

```typescript
import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({ name: 'invite', arguments: '<email>', description: '邀请一个封测用户' })
export class InviteCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const result = await this.admin.inviteUser(inputs[0]);

    console.log(`已邀请 ${result.email}`);
    console.log(`邀请码（只显示这一次）：${result.invitationToken}`);
    console.log(`有效期至：${result.expiresAt.toISOString()}`);
  }
}
```

创建 `src/admin/commands/course.command.ts`：

```typescript
import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({ name: 'course:create', arguments: '<slug> <title>', description: '新建课程' })
export class CourseCreateCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const course = await this.admin.createCourse(inputs[0], inputs[1]);
    console.log(`已创建课程 ${course.slug}（${course.title}），尚未发布`);
  }
}

@Command({ name: 'course:publish', arguments: '<slug>', description: '发布课程' })
export class CoursePublishCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const course = await this.admin.publishCourse(inputs[0]);
    console.log(`已发布课程 ${course.slug}`);
  }
}
```

创建 `src/admin/commands/enroll.command.ts`：

```typescript
import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({ name: 'enroll', arguments: '<email> <courseSlug>', description: '给用户开课' })
export class EnrollCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    await this.admin.enrollUser(inputs[0], inputs[1]);
    console.log(`已为 ${inputs[0]} 开通课程 ${inputs[1]}`);
  }
}
```

创建 `src/admin/commands/quota.command.ts`：

```typescript
import { Command, CommandRunner } from 'nest-commander';
import { AdminService } from '../admin.service';

@Command({ name: 'quota:grant', arguments: '<email> <minutes>', description: '给用户发放运行额度（分钟）' })
export class QuotaGrantCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const minutes = Number.parseInt(inputs[1], 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new Error(`分钟数必须是正整数，收到：${inputs[1]}`);
    }

    const grant = await this.admin.grantQuota(inputs[0], minutes);
    console.log(`已为 ${inputs[0]} 发放 ${grant.minutesGranted} 分钟额度`);
  }
}
```

- [ ] **Step 7: 建 AdminModule 与 CLI 入口**

创建 `src/admin/admin.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InviteCommand } from './commands/invite.command';
import { CourseCreateCommand, CoursePublishCommand } from './commands/course.command';
import { EnrollCommand } from './commands/enroll.command';
import { QuotaGrantCommand } from './commands/quota.command';

@Module({
  providers: [
    AdminService,
    InviteCommand,
    CourseCreateCommand,
    CoursePublishCommand,
    EnrollCommand,
    QuotaGrantCommand,
  ],
  exports: [AdminService],
})
export class AdminModule {}
```

创建 `src/cli.ts`：

```typescript
import 'dotenv/config';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

async function bootstrap() {
  await CommandFactory.run(AppModule, ['warn', 'error']);
}
void bootstrap();
```

在 `src/app.module.ts` 的 imports 里加入 `AdminModule`：

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, AdminModule, HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

在 `package.json` 的 `scripts` 里追加：

```json
    "cli": "ts-node -r tsconfig-paths/register src/cli.ts"
```

- [ ] **Step 8: 手工跑一遍完整运营流程**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
docker compose up -d
npm run cli -- invite pilot@example.com
npm run cli -- course:create n8n "n8n 自动化工作流"
npm run cli -- course:publish n8n
npm run cli -- enroll pilot@example.com n8n
npm run cli -- quota:grant pilot@example.com 600
```

预期：`invite` 打印一行邀请码（40+ 位 base64url）与到期时间；后四条各打印一句成功信息。把邀请码复制下来做下一步。

- [ ] **Step 9: 用 CLI 发的邀请码走通 HTTP 登录**

不要手工复制粘贴邀请码 —— 用一个新邮箱重新发一次并直接从输出里抓：

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
EMAIL="pilot-$(date +%s)@example.com"
INVITE=$(npm run --silent cli -- invite "$EMAIL" | sed -n 's/^邀请码（只显示这一次）：//p')
echo "邮箱=$EMAIL  邀请码长度=${#INVITE}"

npm run start:dev > /tmp/aivirteach-cli-check.log 2>&1 &
SERVER_PID=$!
until curl -sf http://localhost:4000/api/v1/health > /dev/null; do sleep 1; done

echo "--- accept ---"
curl -s -X POST http://localhost:4000/api/v1/auth/invitations/accept \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$INVITE\",\"password\":\"closed-beta-2026\"}" | head -c 200
echo
echo "--- login ---"
curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"closed-beta-2026\"}" | head -c 200
echo

kill $SERVER_PID
```

预期：`邀请码长度` ≥ 43；accept 和 login 两次都返回含 `accessToken` / `refreshToken` / `expiresIn` 的 JSON。这一步跑通说明 CLI 与 HTTP 两条路对上了同一套数据。

若 `INVITE` 抓出来是空的，说明 `invite.command.ts` 的输出前缀跟 `sed` 里的不一致 —— 直接跑 `npm run --silent cli -- invite test@example.com` 看实际输出，按实际前缀调整 `sed` 表达式。

- [ ] **Step 10: 全量检查并提交**

```bash
npm run lint && npm run build && npm test && npm run test:e2e
git add -A
git commit -m "feat: 加入运营 CLI（邀请/开课/选课/发额度）"
```

---

## 完成标准

全部任务做完后，下面三条必须同时成立：

1. `npm run lint && npm run build && npm test` 全绿，单元测试不依赖任何外部服务
2. `docker compose up -d && npm run test:e2e` 全绿
3. 一条命令链能从零把一个封测用户跑到可登录状态：
   `npm run cli -- invite <email>` → `POST /api/v1/auth/invitations/accept` → `POST /api/v1/auth/login` → `GET /api/v1/auth/me` 返回该用户

**本计划明确不做**（属于计划 A.5 / B 或后续 Linear issue）：
- client 那 14 个端点与配套数据表（见下节「计划 A.5」）
- Labs gRPC client（SRV-009）、Workspace 异步编排（SRV-010）、console 票签发（SRV-011）
- quota 的预留与核销逻辑（SRV-012）——本计划只建模型和发放入口
- 课程 YAML/Markdown schema 与校验器（SRV-006）——本计划的 Course 模型只有 slug/title/publishedAt
- OpenAPI artifact 发布与 TS SDK（SRV-018）
- 审计日志、限流、统一错误处理（SRV-017）

---

## 三仓库集成现状（2026-08-11 用 `gh` 逐分支核对）

写这份计划时 server 是三个仓库里唯一还没有代码的。另外两个已推的代码与
`maic/docs/educationproject/2026-08-11-aivirteach-technical-architecture.html` 的决策存在偏差，**执行本计划前必须知道**，否则会按架构文档写出跟 client 对不上的东西。

| Repo · 分支 | 实际是什么 | 对本计划的影响 |
|---|---|---|
| `client` · `FrontEnd-v0`（08-09） | **Next.js 16 + React 19 + Vinext**，Cloudflare Worker 部署，9 个页面做完，零 Tauri。配置里带 `.openai/hosting.json`、`site-creator-d1` 占位符、`CODEX_SANDBOX` 注释、`vinext-starter template` 字样——**由 Codex 从建站模板生成**，提交信息自述用途是 "public demo" | **不是本计划要对接的客户端**。它在 `app/lib/api.ts` 里有一套 14 端点的契约，但那套数据模型（streak / 徽章 / 技能雷达 / Free-Premium）是模板自带的通用 e-learning 概念，与封测的 workspace / quota / attempt 不重叠。其 `mock-profile.ts` 可作为 seed 参考数据 |
| `client` · `vm_vlient`（08-10） | **Tauri v2 + Rust IronRDP**，Windows，SSH 隧道连 xrdp，连接参数硬编码 | 绕过 server，本计划不涉及。将来要改成向 server 索取连接信息 |
| `labs` · `vm_module`（08-10） | **libvirt/KVM bash 脚本**，镜像 Ubuntu 24.04 + XFCE + XRDP。**是脚本不是服务，无任何可调用接口** | 本计划不接 Labs。计划 A.5 要先立 `LabDriver` 接口 + Fake 实现把它隔离掉 |
| `server` · `main` | 只有 README，**GitHub 上零行代码** | 本地骨架未推送也未 git init —— Task 1 的 `git init` 前提成立 |

**开发机跑不了完整链路**：Labs 依赖 KVM（Linux 内核虚拟化），macOS 没有。所以 `LabDriver` 拆成接口 + 多实现不是设计品味，是物理约束。

**Labs 目前只有私网地址** `10.162.179.63`（RFC1918）。任何对外部署都打不到它。这条与 server 选型无关，必须 Labs 侧解决；在此之前 server 一律用 `FakeLabDriver`，不被阻塞。

---

## 接下来：计划 A.5（尚未展开成可执行计划）

本计划跑完后，server 能自签 JWT 登录、能用 CLI 发邀请开课发额度——但还没有任何**业务**端点。补齐这段是计划 A.5，范围如下（**这是范围说明，不是可执行计划；执行前需按 writing-plans 展开成带完整代码的分步任务**）：

1. **课程与进度模型**：`Course` 补展示字段（简介 / 分类 / 难度 / 预计时长）+ `CourseStep`；`Enrollment` 补 `level` / `currentStepId` / `progress` + `StepProgress`（对应 SRV-006 / SRV-007 / SRV-008）
2. **只读业务端点**：课程列表 / 课程详情 / 我的选课 / 当前进度 —— 场景 A 的完整实现（见架构文档「两个运行场景」）
3. **`Workspace` 模型 + 异步编排骨架**：`POST /workspaces` 立刻返回 `202 PROVISIONING`，状态经 WebSocket 推送（决策 #3）。此步只做 server 侧状态机，Labs 用 Fake 顶
4. **`LabDriver` 接口 + `FakeDriver`**：`create` / `start` / `stop` / `destroy` / `status`，`status` 返回 `{status, ip, rdpPort}`。Fake 用定时器把 `PROVISIONING` 推进到 `RUNNING`。**开发机是 macOS 无 KVM，Fake 是唯一能本地跑的实现**
5. **seed 脚本**：封测三门课（n8n 主课 + Codex / AI 做 CV 两个 Mini Course）+ 若干测试用户。参考数据可从 `client/FrontEnd-v0/app/lib/mock-profile.ts` 与 `courses.ts` 里取，省去自己编
6. **契约发布**：从 Zod schema 导出 OpenAPI 3.1 到仓库固定路径（SRV-018）。**契约以 server 为来源**——client 从这个文件生成客户端，而不是 server 去猜 client 想要什么

**待确认（影响第 2 步的形状，不影响其余五步）**：`FrontEnd-v0/app/lib/api.ts` 那 14 个端点是真实产品需求，还是 Codex 生成模板时自带的？若是前者，第 2 步要同时满足两套形状；若是后者（配置证据倾向于后者），按本文档的模型做即可，那套 UI 将来需要重新接线。

跑完 A.5 的验收标准：**登录 → 看课程 → 选课 → 创建 workspace → 收到状态从 `PROVISIONING` 变 `RUNNING` 的推送，全链路 e2e 绿；全程不依赖任何真实 Labs 主机。**
