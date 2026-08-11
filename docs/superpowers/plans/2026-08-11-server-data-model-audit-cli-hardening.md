# AIVirTeach Server — 数据模型补全、审计日志与运营 CLI 加固 实施计划（计划 B）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Linear `SRV-002`（核心数据模型）、`SRV-004`（认证审计）、`SRV-005`（运营 CLI）三张票在计划 A（`2026-08-11-server-foundation-and-auth.md`）之后仍缺的验收标准：把数据模型从 6 个扩到 Linear AC 要求的 10 个，给认证事件和运营 CLI 的每次写操作接入统一的 append-only 审计日志，并给运营 CLI 加上显式 operator/reason、默认 dry-run 和结构化输出。`SRV-001` 的 CI 验收项（GitHub Actions 等自动化）明确排除，本计划不做。

**Architecture:** 新增 `AuditEvent` 模型作为唯一的操作留痕来源——业务表本身不重复存 operator/reason，需要追溯时按 `targetType`/`targetId` 关联查询。`AuditService` 是唯一写 `AuditEvent` 的入口，`AuthService`（用户自己触发）和 `AdminService`（运营 CLI 触发）都通过它记录，不直接操作 `prisma.auditEvent`。课程从「一个 Course 直接有 publishedAt」改成「Course 是身份，CourseVersion 是不可变版本，publishedAt 挂在版本上」，为将来 SRV-007 的课程发布/读取 API 打基础，但这次不实现那些读接口。`QuotaGrant` 改名重设计为 `QuotaLedger`（只增不改的流水账：这次只产生正数「发放」条目，未来 SRV-010/012 接入真实 VM 用量后会追加负数「消耗」条目）。新增的 `Workspace`/`Progress`/`Attempt`/`Conversation` 四个模型这次只建表、建关系、建索引，字段形状参考了 Linear 上对应的客户端票（CLI-008/010/012/013/014/015）会怎么读这些数据，但读接口本身属于 SRV-007/009/010/012/013/014/015，不在这次范围内。

**Tech Stack:** 延续计划 A：NestJS 11 · Prisma 6 + PostgreSQL 17 · zod 4（CLI 边界校验）· nest-commander 3（`Option` 装饰器加运营 CLI 参数）· Jest 30 + supertest

**上游依据：** Linear `SRV-002`、`SRV-004`、`SRV-005` 的实际 Acceptance Criteria（不是标题），核对方式见对话记录；`docs/superpowers/plans/2026-08-11-server-foundation-and-auth.md`（计划 A，本计划在其之上继续）。

## Global Constraints

- **仓库根目录**：`/Users/owenlee/Desktop/2025年/项目/aivirteach-server`
- **继续在现有分支上工作**：`feat/srv-004-self-signed-auth`，不新建分支，不合并到 `main`，不 push
- **Node.js 24.18.0 / npm**，不引入 pnpm/yarn
- **端口不变**：Postgres 55432 / Redis 56379（docker-compose 已在跑）
- **不做 CI**：`SRV-001` 的 lint/typecheck/test/build 自动化验收项不在本计划范围内，不要新增 `.github/workflows` 或任何 CI 配置
- **审计是唯一真相来源**：任何写操作（认证事件、运营 CLI 变更）都必须经过 `AuditService.record()`；业务表不重复存 operator/reason 字段
- **`AuditEvent` 只增不改不删**：代码里任何地方都不允许对 `prisma.auditEvent` 调用 `update`/`delete`/`updateMany`/`deleteMany`
- **运营 CLI 默认 dry-run**：五个命令不加 `--execute` 时只打印将要发生的变更，不写库；`--operator`/`--reason` 两个参数必填，dry-run 模式下也要填（预览也要留痕是谁在问、为什么问）
- **zod 4.x**：`z.email()`，错误从 `.issues[]` 取
- **不可变风格**：不原地修改传入对象/数组，一律返回新对象
- **单元测试**（`src/**/*.spec.ts`）不连数据库；**e2e**（`test/**/*.e2e-spec.ts`）才连 Postgres
- **中文注释，英文标识符**，单引号、2 空格缩进、结尾分号，与现有代码风格一致
- **本地测试库当前只有开发期的测试脏数据**（e2e 跑测/手动验证留下的 User/Course/Enrollment/QuotaGrant 记录），迁移过程中如果 Prisma 提示会丢失数据，可以直接确认——不是需要保留的真实数据
- **Task 1 结束到 Task 5 结束之前，全量的 `npm run build` / `npm run lint` / `npm test` 会一直报错，这是预期的，不是哪一步做错了**：`src/admin/commands/*.command.ts` 四个 CLI 命令文件消费 `AdminService` 返回值的具体字段（比如 `quota.command.ts` 读 `grant.minutesGranted`、`course.command.ts` 的 `CoursePublishCommand` 读 `course.slug`），Task 1 改了 `AdminService` 的返回形状（`QuotaLedger.minutesDelta` 取代 `QuotaGrant.minutesGranted`，`publishCourse` 改回 `CourseVersion` 没有 `slug` 字段），但这四个命令文件要等 Task 5 才会跟着改。Task 1-4 期间验证范围收窄到 `npx jest <具体路径>`，不要跑全量三连命令；只有 Task 5 结束时全量三连命令才会重新全绿，那时候才是最终验收点

---

## File Structure

```
aivirteach-server/
├── prisma/
│   ├── schema.prisma                          ✎ 新增 7 个模型/4 个枚举，Course/Enrollment 调整，QuotaGrant→QuotaLedger
│   └── migrations/xxxxxxxx_expand_core_data_model/  ★ 新迁移
├── src/
│   ├── audit/
│   │   ├── audit.service.ts                    ★ 唯一写 AuditEvent 的入口
│   │   ├── audit.service.spec.ts                ★
│   │   └── audit.module.ts                      ★ @Global()，与 PrismaModule 同模式
│   ├── auth/
│   │   ├── auth.service.ts                      ✎ 四个方法接入 AuditService
│   │   └── auth.service.spec.ts                  ✎ 加 AuditService mock 与断言
│   ├── admin/
│   │   ├── admin.service.ts                      ✎ 五个方法加 operator/reason 参数，接入 AuditService，QuotaLedger/CourseVersion
│   │   ├── admin.service.spec.ts                  ✎
│   │   ├── admin.schemas.ts                       ★ zod OperatorSchema/ReasonSchema
│   │   ├── admin.schemas.spec.ts                  ★
│   │   └── commands/
│   │       ├── invite.command.ts                  ✎ 加 --operator/--reason/--execute
│   │       ├── course.command.ts                  ✎ 同上，course:create 加可选 --image-digest
│   │       ├── enroll.command.ts                  ✎ 同上
│   │       └── quota.command.ts                   ✎ 同上
│   └── app.module.ts                              ✎ 引入 AuditModule
└── test/
    └── schema.e2e-spec.ts                         ✎ 加新模型的落库/级联断言
```

**关于 CLI 命令里 `--operator`/`--reason`/`--execute` 三个 `@Option` 解析方法会在五个命令文件里各写一份、不抽公共基类**：nest-commander 的 `@Option` 装饰器要挂在 `CommandRunner` 具体子类上才能被发现，用继承共享装饰器方法这条路没有被官方文档确认过，为了让计划里的每一步都能可靠跑通，这里选择接受五份三行小方法的重复，而不是冒险搭一个未经验证的抽象。

---

## Task 1: 扩充 Prisma 数据模型

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/xxxxxxxx_expand_core_data_model/`（由 `prisma migrate dev` 生成，时间戳不可预先指定）
- Modify: `src/admin/admin.service.ts:1-2`（只改 import，逻辑留到 Task 4）
- Modify: `test/schema.e2e-spec.ts`

**Interfaces:**
- Produces：`AuditActorType` / `WorkspaceStatus` / `AttemptStatus` / `ConversationRole` 四个 Prisma 枚举，`CourseVersion` / `Workspace` / `Progress` / `Attempt` / `Conversation` / `QuotaLedger` / `AuditEvent` 七个新模型，均从 `@prisma/client` 导出供后续任务使用。

- [ ] **Step 1: 读一遍当前 schema，确认改动范围**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
cat prisma/schema.prisma
```

确认现状：`Course` 有 `publishedAt` 字段、无版本概念；`Enrollment` 只有 `userId`/`courseId`；`QuotaGrant` 是单次发放记录（`minutesGranted`/`minutesUsed`）。这一步不改代码，只是确认起点没有漂移。

- [ ] **Step 2: 写新的 schema.prisma**

把整个文件替换成：

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

enum WorkspaceStatus {
  CREATING
  RUNNING
  STOPPED
  ERROR
  RESETTING
}

enum AttemptStatus {
  PASS
  FAIL
  ERROR
}

enum ConversationRole {
  USER
  ASSISTANT
  SYSTEM
}

enum AuditActorType {
  USER
  OPERATOR
  SYSTEM
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
  quotaLedgers  QuotaLedger[]
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
  id        String   @id @default(cuid())
  slug      String   @unique
  title     String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  versions    CourseVersion[]
  enrollments Enrollment[]
}

model CourseVersion {
  id       String @id @default(cuid())
  courseId String
  course   Course @relation(fields: [courseId], references: [id], onDelete: Cascade)
  version  Int
  // KubeVirt/Docker 镜像摘要；Labs 集成（SRV-009）前允许为空，创建/发布时如果有就填。
  imageDigest String?
  content     Json     @default("{}")
  publishedAt DateTime?
  createdAt   DateTime  @default(now())

  enrollments Enrollment[]

  @@unique([courseId, version])
  @@index([courseId])
}

model Enrollment {
  id     String @id @default(cuid())
  userId String
  courseId String
  // 学习者真正开始（workspace 启动，SRV-010 范围）时固定到某个版本；之前为 null。
  courseVersionId String?
  user            User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  course          Course         @relation(fields: [courseId], references: [id], onDelete: Cascade)
  courseVersion   CourseVersion? @relation(fields: [courseVersionId], references: [id])
  createdAt       DateTime       @default(now())

  workspace     Workspace?
  progress      Progress?
  attempts      Attempt[]
  conversations Conversation[]

  @@unique([userId, courseId])
  @@index([courseId])
  @@index([courseVersionId])
}

model Workspace {
  id           String          @id @default(cuid())
  enrollmentId String          @unique
  enrollment   Enrollment      @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  status       WorkspaceStatus @default(CREATING)
  errorMessage String?
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
}

model Progress {
  id           String     @id @default(cuid())
  enrollmentId String     @unique
  enrollment   Enrollment @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  currentStep  Int        @default(0)
  updatedAt    DateTime   @updatedAt
}

model Attempt {
  id           String        @id @default(cuid())
  enrollmentId String
  enrollment   Enrollment    @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  stepIndex    Int
  status       AttemptStatus
  exitCode     Int?
  // 评测的原始 stdout，不截断；不单独存一个脱离证据的 passed:true。
  stdout    String?
  fileHash  String?
  createdAt DateTime @default(now())

  @@index([enrollmentId, stepIndex])
}

model Conversation {
  id           String           @id @default(cuid())
  enrollmentId String
  enrollment   Enrollment       @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  role         ConversationRole
  content      String
  // 引用的上下文（当前步骤、截图、评测结果等），结构随 AI Teacher Adapter（SRV-014）定，这里先存原样 JSON。
  contextRef Json?
  createdAt  DateTime @default(now())

  @@index([enrollmentId])
}

model QuotaLedger {
  id     String @id @default(cuid())
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  // 正数 = 发放。未来 SRV-010/012 接入真实 VM 用量后会追加负数的消耗条目；这次只产生正数。
  minutesDelta Int
  expiresAt    DateTime?
  createdAt    DateTime  @default(now())

  @@index([userId])
}

model AuditEvent {
  id        String         @id @default(cuid())
  actorType AuditActorType
  // USER：user.id，或找不到用户时尝试登录/接受邀请用的邮箱都取不到时为 null；
  // OPERATOR：CLI --operator 传入的邮箱；SYSTEM：始终为 null。
  actorId    String?
  action     String
  success    Boolean
  targetType String?
  targetId   String?
  // OPERATOR 触发的事件必填（CLI 层用 zod 校验保证）；USER/SYSTEM 触发的可选。
  reason    String?
  metadata  Json?
  createdAt DateTime @default(now())

  @@index([actorId])
  @@index([action])
}
```

- [ ] **Step 2.5: 让 AdminService 跟上新 schema（不加 operator/reason，那是 Task 4 的事）**

`Course.publishedAt` 挪到了 `CourseVersion`、`QuotaGrant` 改名 `QuotaLedger`——`src/admin/admin.service.ts` 里 `createCourse`/`publishCourse`/`grantQuota` 三个方法引用的字段和表名都会跟着失效，不改的话 Task 1 结束时 `npm run build` 会报错。这一步只做「跟上新表结构」的最小改动：`createCourse` 顺带建版本 1，`publishCourse` 改成发布最新版本，`grantQuota` 改成写 `QuotaLedger`。**不加 operator/reason 参数、不接审计**——那是 Task 4 在这基础上叠加的东西。

把 `src/admin/admin.service.ts` 顶部的 import 改成：

```typescript
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, CourseVersion, Enrollment, QuotaLedger } from '@prisma/client';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
```

把 `createCourse` 方法改成：

```typescript
  async createCourse(
    slug: string,
    title: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    return this.prisma.course.create({
      data: { slug, title, versions: { create: { version: 1 } } },
      include: { versions: true },
    });
  }
```

把 `publishCourse` 方法改成：

```typescript
  async publishCourse(slug: string): Promise<CourseVersion> {
    const course = await this.requireCourse(slug);
    const latest = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id },
      orderBy: { version: 'desc' },
    });
    if (!latest) {
      throw new NotFoundException(`课程 ${slug} 还没有任何版本`);
    }

    // 已经发布过就直接返回，不二次写 publishedAt——发布本身要是幂等操作。
    return latest.publishedAt
      ? latest
      : this.prisma.courseVersion.update({
          where: { id: latest.id },
          data: { publishedAt: new Date() },
        });
  }
```

把 `grantQuota` 方法改成：

```typescript
  async grantQuota(email: string, minutes: number): Promise<QuotaLedger> {
    const user = await this.requireUser(email);

    return this.prisma.quotaLedger.create({
      data: { userId: user.id, minutesDelta: minutes },
    });
  }
```

`inviteUser`/`enrollUser`/`requireUser`/`requireCourse` 四个方法这一步不用动——`Enrollment` 新增的 `courseVersionId` 字段是可选的，`enrollUser` 现有的 `create({data: {userId, courseId}})` 调用不受影响，照常编译通过。

- [ ] **Step 2.6: 让 admin.service.spec.ts 跟上 Step 2.5 的改动**

现有的 `src/admin/admin.service.spec.ts` 里，`buildPrisma()` 还在 mock `course.update` 和 `quotaGrant`，"发布课程时写入 publishedAt" 这个测试断言的是旧的 `prisma.course.update` 调用——Step 2.5 改完之后这个测试会失败（`publishCourse` 不再调用 `course.update`）。把整个文件替换成：

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
  CORS_ORIGINS: 'tauri://localhost',
};

const buildPrisma = () => ({
  user: { upsert: jest.fn(), findUnique: jest.fn() },
  invitation: { create: jest.fn().mockResolvedValue({ id: 'inv_1' }) },
  course: { create: jest.fn(), findUnique: jest.fn() },
  courseVersion: { findFirst: jest.fn(), update: jest.fn() },
  enrollment: { create: jest.fn() },
  quotaLedger: { create: jest.fn() },
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
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'new@example.com',
    });
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
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'dup@example.com',
    });
    const service = await buildService(prisma);

    await service.inviteUser('dup@example.com');

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'dup@example.com' } }),
    );
  });
});

describe('AdminService.createCourse / publishCourse', () => {
  it('创建课程时一并建第一个 CourseVersion（version=1，未发布）', async () => {
    const prisma = buildPrisma();
    prisma.course.create.mockResolvedValue({
      id: 'course_1',
      slug: 'n8n',
      versions: [{ id: 'cv_1', version: 1, publishedAt: null }],
    });
    const service = await buildService(prisma);

    await service.createCourse('n8n', 'n8n 自动化工作流');

    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'n8n',
          versions: { create: { version: 1 } },
        }),
      }),
    );
  });

  it('发布课程时给最新版本写 publishedAt', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue({
      id: 'cv_1',
      courseId: 'course_1',
      version: 1,
      publishedAt: null,
    });
    prisma.courseVersion.update.mockResolvedValue({
      id: 'cv_1',
      publishedAt: new Date(),
    });
    const service = await buildService(prisma);

    await service.publishCourse('n8n');

    expect(prisma.courseVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cv_1' },
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
  });

  it('重复发布同一版本是幂等的，不会二次写 publishedAt', async () => {
    const prisma = buildPrisma();
    const already = { id: 'cv_1', courseId: 'course_1', version: 1, publishedAt: new Date() };
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue(already);
    const service = await buildService(prisma);

    const result = await service.publishCourse('n8n');

    expect(prisma.courseVersion.update).not.toHaveBeenCalled();
    expect(result).toBe(already);
  });

  it('课程没有任何版本时发布抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.publishCourse('n8n')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminService 其余运营操作', () => {
  it('给不存在的用户发额度抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(
      service.grantQuota('ghost@example.com', 120),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('给不存在的课程选课抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    prisma.course.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(
      service.enrollUser('a@b.com', 'no-such-course'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('发放额度写入 QuotaLedger 的正数流水', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1', email: 'a@b.com' });
    prisma.quotaLedger.create.mockResolvedValue({
      id: 'ledger_1',
      userId: 'user_1',
      minutesDelta: 120,
    });
    const service = await buildService(prisma);

    const entry = await service.grantQuota('a@b.com', 120);

    expect(entry.minutesDelta).toBe(120);
    expect(prisma.quotaLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 'user_1', minutesDelta: 120 } }),
    );
  });
});
```

**这一步先不要运行测试**：`ts-jest` 在这个项目里是全类型检查模式（没设 `isolatedModules`），而这两个文件引用的 `courseVersion`/`quotaLedger`/`CourseVersion`/`QuotaLedger` 现在还只存在于 `schema.prisma` 源文件里，Prisma Client 要等 Step 3 的 `prisma migrate dev` 跑完才会重新生成、把这些类型和方法真正加进 `@prisma/client`。这时候跑 `npx jest` 会因为类型对不上而报错，不代表代码写错了——先往下走。

- [ ] **Step 3: 生成迁移**

```bash
cd "/Users/owenlee/Desktop/2025年/项目/aivirteach-server"
npm run db:migrate -- --name expand_core_data_model
```

预期：Prisma 检测到 `QuotaGrant`→`QuotaLedger`、`Course.publishedAt` 被移除等改动，可能会提示会有数据丢失（本地库目前只有测试脏数据，见 Global Constraints，确认继续即可）。命令结束时应打印 `Your database is now in sync with your schema.`，并在 `prisma/migrations/` 下新增一个以时间戳开头、`_expand_core_data_model` 结尾的目录。

- [ ] **Step 4: 确认 Prisma Client 类型生成正确**

```bash
grep -n "CourseVersion\|Workspace\|QuotaLedger\|AuditEvent" node_modules/.prisma/client/index.d.ts | head -20
```

预期：能看到这几个类型的定义（不是空输出）。如果编辑器仍显示旧的 `QuotaGrant`/`clerkId` 之类的诊断，以这条命令的真实输出为准，不要相信编辑器缓存。

- [ ] **Step 4.5: 现在补跑 Step 2.6 的测试**

```bash
npx jest src/admin/admin.service.spec.ts
```

预期：PASS，8 个测试全过。如果这里报错，先看是不是真的逻辑问题（比如 Step 2.5 的方法体和 Step 2.6 的 mock 对不上），而不是又一次类型未生成的假象——Step 3/4 已经把 Prisma Client 重新生成过了，这里失败就是真失败。

- [ ] **Step 5: 扩充 schema.e2e-spec.ts，验证新模型能落库、级联删除生效**

打开 `test/schema.e2e-spec.ts`。文件里的 `prisma` 变量是 `describe('数据库 schema', ...)` 块内部的 `const`，新用例必须插到那个 `describe` 块内、`afterAll` 之后、原有两个 `it(...)` 之后、块末尾的 `});`（第 41 行）**之前**——不能直接加在文件最后，否则 `prisma` 不在作用域内，会报 `ReferenceError`：

```typescript
it('CourseVersion 归属 Course，course 被删时版本一并删除', async () => {
  const course = await prisma.course.create({
    data: {
      slug: `cascade-course-${Date.now()}`,
      title: '级联测试课程',
      versions: { create: { version: 1, content: {} } },
    },
    include: { versions: true },
  });

  await prisma.course.delete({ where: { id: course.id } });

  const remaining = await prisma.courseVersion.findUnique({
    where: { id: course.versions[0].id },
  });
  expect(remaining).toBeNull();
});

it('QuotaLedger 记录是流水账条目，同一用户可以有多条', async () => {
  const user = await prisma.user.create({
    data: { email: `ledger-${Date.now()}@example.com` },
  });

  await prisma.quotaLedger.create({ data: { userId: user.id, minutesDelta: 60 } });
  await prisma.quotaLedger.create({ data: { userId: user.id, minutesDelta: 30 } });

  const entries = await prisma.quotaLedger.findMany({ where: { userId: user.id } });
  const balance = entries.reduce((sum, entry) => sum + entry.minutesDelta, 0);

  expect(entries).toHaveLength(2);
  expect(balance).toBe(90);

  await prisma.user.delete({ where: { id: user.id } });
});

it('AuditEvent 可以记录一条没有 actorId 的事件（找不到对应用户时）', async () => {
  const event = await prisma.auditEvent.create({
    data: {
      actorType: 'USER',
      actorId: null,
      action: 'auth.login',
      success: false,
    },
  });

  expect(event.actorId).toBeNull();
  expect(event.reason).toBeNull();
});
```

- [ ] **Step 6: 跑 e2e 确认通过**

```bash
npm run test:e2e
```

预期：`test/schema.e2e-spec.ts` 里新增的 3 个断言全部 PASS（连同原有测试，共 3 个 e2e 套件全绿；`test/auth.e2e-spec.ts` 会因为 AuthService 还没接 AuditService 而保持现状不受影响）。

- [ ] **Step 7: 跑受影响范围内的单元测试**

见 Global Constraints 里的说明——`src/admin/commands/*.command.ts` 还没跟上 `AdminService` 新的返回形状，这一步**不要**跑全量 `npm run lint`/`npm run build`/`npm test`，只跑 Task 1 实际改到的测试：

```bash
npx jest src/admin src/config src/health
```

预期：全部 PASS（这几个目录下的 `*.spec.ts` 不会 import 到 `src/admin/commands/`，Jest 不会碰到那四个还没改的命令文件）。

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/admin/admin.service.ts src/admin/admin.service.spec.ts test/schema.e2e-spec.ts
git commit -m "feat: 扩充数据模型到 SRV-002 要求的 10 个模型"
```

---

## Task 2: AuditService — 唯一的审计写入入口

**Files:**
- Create: `src/audit/audit.service.ts`
- Create: `src/audit/audit.service.spec.ts`
- Create: `src/audit/audit.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes：Task 1 产出的 `AuditActorType` 枚举、`AuditEvent` 模型
- Produces：`AuditActor` 类型、`RecordAuditEventInput` 接口、`AuditService.record(input: RecordAuditEventInput): Promise<void>`，供 Task 3（AuthService）和 Task 4（AdminService）注入使用

- [ ] **Step 1: 写失败的测试**

创建 `src/audit/audit.service.spec.ts`：

```typescript
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

const buildService = async (create: jest.Mock) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuditService,
      { provide: PrismaService, useValue: { auditEvent: { create } } },
    ],
  }).compile();
  return moduleRef.get(AuditService);
};

describe('AuditService.record', () => {
  it('USER 事件把 actor.id 写进 actorId', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = await buildService(create);

    await service.record({
      actor: { type: AuditActorType.USER, id: 'user_1' },
      action: 'auth.login',
      success: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: AuditActorType.USER,
        actorId: 'user_1',
        action: 'auth.login',
        success: true,
        reason: null,
      }),
    });
  });

  it('SYSTEM 事件的 actorId 强制为 null，即使传了 id 之外的字段', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = await buildService(create);

    await service.record({
      actor: { type: AuditActorType.SYSTEM },
      action: 'quota.expire',
      success: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorType: AuditActorType.SYSTEM, actorId: null }),
    });
  });

  it('OPERATOR 事件带 reason 和 target 时原样落库', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = await buildService(create);

    await service.record({
      actor: { type: AuditActorType.OPERATOR, id: 'ops@example.com' },
      action: 'admin.inviteUser',
      success: true,
      targetType: 'User',
      targetId: 'user_2',
      reason: '封测名单批次 3',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: AuditActorType.OPERATOR,
        actorId: 'ops@example.com',
        targetType: 'User',
        targetId: 'user_2',
        reason: '封测名单批次 3',
      }),
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx jest src/audit/audit.service.spec.ts
```

预期：FAIL，`Cannot find module './audit.service'`。

- [ ] **Step 3: 实现 AuditService**

创建 `src/audit/audit.service.ts`：

```typescript
import { Injectable } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditActor =
  | { type: typeof AuditActorType.USER; id: string | null }
  | { type: typeof AuditActorType.OPERATOR; id: string }
  | { type: typeof AuditActorType.SYSTEM };

export interface RecordAuditEventInput {
  actor: AuditActor;
  action: string;
  success: boolean;
  targetType?: string;
  targetId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// 全项目唯一允许写 AuditEvent 的地方；只增不改不删，别的地方不要直接碰 prisma.auditEvent。
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorType: input.actor.type,
        actorId: input.actor.type === AuditActorType.SYSTEM ? null : input.actor.id,
        action: input.action,
        success: input.success,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata,
      },
    });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx jest src/audit/audit.service.spec.ts
```

预期：PASS，3 个测试。

- [ ] **Step 5: 建 AuditModule 并接入 AppModule**

创建 `src/audit/audit.module.ts`：

```typescript
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// 跟 PrismaModule 一样全局注册：Auth、Admin 以及未来任何模块都要能直接注入，
// 不用每个 feature module 都重复 import 一遍。
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

修改 `src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

- [ ] **Step 6: 跑受影响范围内的单元测试**

见 Global Constraints 的说明——这一步仍处在 Task 1 留下的「CLI 命令文件还没跟上」窗口期内，不要跑全量 `npm run lint`/`npm run build`/`npm test`：

```bash
npx jest src/audit
```

预期：全部 PASS，3 个测试。

- [ ] **Step 7: Commit**

```bash
git add src/audit src/app.module.ts
git commit -m "feat: 加入 AuditService 作为唯一的审计写入入口"
```

---

## Task 3: AuthService 四个方法接入审计

**Files:**
- Modify: `src/auth/auth.service.ts`
- Modify: `src/auth/auth.service.spec.ts`
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Consumes：Task 2 的 `AuditService`、`AuditActor` 类型
- Produces：无新导出，`AuthService` 的公开方法签名不变（`acceptInvitation`/`login`/`refresh`/`logout` 参数和返回类型都不变，只是内部多了审计调用）

- [ ] **Step 1: 在测试里加 AuditService mock 和第一个失败断言**

打开 `src/auth/auth.service.spec.ts`，把 `import` 和 `buildService` 改成：

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { hashOpaqueToken, verifyAccessToken } from './tokens';
```

```typescript
const buildService = async (prisma: PrismaStub, audit = { record: jest.fn() }) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(AuthService), audit };
};
```

这一步改了 `buildService` 的返回形状（从直接返回 `service` 变成 `{ service, audit }`），下一步会跟着改调用点。先只加第一个新断言，登录成功那个测试改成：

```typescript
describe('AuthService.login', () => {
  it('凭证正确时返回可验签的 access token 和不透明 refresh token', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_1',
      email: 'learner@example.com',
      passwordHash: await hashPassword('correct-password'),
      status: 'ACTIVE',
    });
    const { service, audit } = await buildService(prisma);

    const pair = await service.login('learner@example.com', 'correct-password');

    await expect(
      verifyAccessToken(pair.accessToken, ENV_STUB.JWT_SECRET),
    ).resolves.toEqual({
      sub: 'user_1',
      email: 'learner@example.com',
    });
    expect(pair.expiresIn).toBe(15 * 60);
    expect(pair.refreshToken).not.toContain('.');
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenHash: hashOpaqueToken(pair.refreshToken),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'USER', id: 'user_1' },
        action: 'auth.login',
        success: true,
      }),
    );
  });
```

其余测试里所有 `const service = await buildService(prisma);` 先原样保留（这一步先不改剩下的调用点，只让这一个测试和它依赖的 `buildService` 新签名同时存在——因为 `buildService` 返回形状变了，其它测试此时会因为拿到 `{ service, audit }` 而不是 `service` 直接报类型错误）。

- [ ] **Step 2: 把其余测试里的 `buildService` 调用点跟着改掉**

把文件里剩下的每一处：

```typescript
const service = await buildService(prisma);
```

改成：

```typescript
const { service } = await buildService(prisma);
```

（不需要断言审计的测试用 `{ service }` 解构就够，`audit` 字段留给下一步要加断言的测试用）

- [ ] **Step 3: 跑测试确认按预期失败**

```bash
npx jest src/auth/auth.service.spec.ts
```

预期：FAIL——`Cannot find module '../audit/audit.service'`（此时还没建这个 import 路径以外的东西，因为 Task 2 已经建好了 `AuditService` 本体，这里失败的原因应该是 `AuthService` 还没注入它，导致 Nest 测试模块编译时找不到 provider，或者是 `audit.record` 断言拿到 `undefined`）。用真实报错信息确认失败原因是"AuthService 还没调用 audit.record"，不是别的原因。

- [ ] **Step 4: 修改 AuthService 接入 AuditService**

把 `src/auth/auth.service.ts` 整个替换成：

```typescript
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  signAccessToken,
  ttlToSeconds,
} from './tokens';

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
    private readonly audit: AuditService,
  ) {}

  async acceptInvitation(token: string, password: string): Promise<TokenPair> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { user: true },
    });

    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.expiresAt <= new Date()
    ) {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: invitation?.userId ?? null },
        action: 'auth.acceptInvitation',
        success: false,
      });
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

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: invitation.user.id },
      action: 'auth.acceptInvitation',
      success: true,
    });

    return this.issueTokens(invitation.user.id, invitation.user.email);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user?.passwordHash || user.status !== 'ACTIVE') {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: user?.id ?? null },
        action: 'auth.login',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: user.id },
        action: 'auth.login',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: user.id },
      action: 'auth.login',
      success: true,
    });

    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
      include: { user: true },
    });

    if (!stored) {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: null },
        action: 'auth.refresh',
        success: false,
      });
      throw new UnauthorizedException(DENIED);
    }

    // 已经轮换过的 token 又被拿来用 —— 说明泄露了，把这个用户所有未撤销的 token 一并作废。
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: stored.userId },
        action: 'auth.refresh',
        success: false,
        reason: '检测到已撤销 token 被重放，已撤销整个 token 家族',
      });
      throw new UnauthorizedException(DENIED);
    }

    if (stored.expiresAt <= new Date() || stored.user.status !== 'ACTIVE') {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: stored.userId },
        action: 'auth.refresh',
        success: false,
      });
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

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: stored.userId },
      action: 'auth.refresh',
      success: true,
    });

    return pair;
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
      include: { user: true },
    });

    // 登出必须幂等：token 不存在或已撤销都当作成功，且不写审计——重复点登出不是安全事件。
    if (!stored || stored.revokedAt) {
      return;
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: stored.userId },
      action: 'auth.logout',
      success: true,
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
        expiresAt: new Date(
          Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
        ),
      },
    });

    return {
      pair: {
        accessToken,
        refreshToken,
        expiresIn: ttlToSeconds(this.env.ACCESS_TOKEN_TTL),
      },
      refreshTokenId: created.id,
    };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npx jest src/auth/auth.service.spec.ts
```

预期：PASS，12 个测试全过。

- [ ] **Step 6: 给 refresh 和 logout 补两个审计断言**（复现 Task 3 意图，不只是让编译过）

在 `describe('AuthService.refresh', ...)` 的第一个测试（`'有效 refresh token 会轮换...'`）里，把 `const service = await buildService(prisma);` 改成 `const { service, audit } = await buildService(prisma);`，并在测试末尾加：

```typescript
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh', success: true }),
    );
```

在 `describe('AuthService.logout', ...)` 的 `'撤销指定的 refresh token'` 测试里同样解构出 `audit`，并加：

```typescript
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', success: true }),
    );
```

在 `'登出一个不存在的 token 不报错（幂等）'` 测试里同样把 `const service = await buildService(prisma);` 改成 `const { service, audit } = await buildService(prisma);`，再加一行确认没有触发审计：

```typescript
    expect(audit.record).not.toHaveBeenCalled();
```

跑一次确认全绿：

```bash
npx jest src/auth/auth.service.spec.ts
```

- [ ] **Step 7: AuthModule 不需要改**

`AuditModule` 是 `@Global()` 的（Task 2 已经在 `AppModule` 里挂了），`AuthService` 直接在构造函数里注入 `AuditService` 就能拿到，不用在 `src/auth/auth.module.ts` 里显式 import `AuditModule`。这一步不用改文件，只是确认不需要改。

- [ ] **Step 8: 跑受影响范围内的单元测试**

同样还在 Task 1 留下的窗口期内，不跑全量三连命令：

```bash
npx jest src/auth src/audit
```

预期：全部 PASS，测试数比 Task 2 结束时多。

- [ ] **Step 9: Commit**

```bash
git add src/auth/auth.service.ts src/auth/auth.service.spec.ts
git commit -m "feat: AuthService 四个方法接入审计日志"
```

---

## Task 4: AdminService 加 operator/reason，接入审计

**Files:**
- Modify: `src/admin/admin.service.ts`
- Modify: `src/admin/admin.service.spec.ts`

**Interfaces:**
- Consumes：Task 2 的 `AuditService`；Task 1 已经把 `createCourse`/`publishCourse`/`grantQuota` 的内部逻辑改成用 `CourseVersion`/`QuotaLedger`（`publishCourse` 返回类型已经是 `CourseVersion`，`grantQuota` 已经是 `QuotaLedger`）——这次不再改这部分逻辑，只是在外面加 operator/reason 两个参数和一次 `audit.record()` 调用
- Produces：`AdminService` 五个方法的新签名（**破坏性变更**，Task 5 的 CLI 命令要跟着改调用点，在 Task 1 的签名基础上都加了 `operator: string, reason: string`）：
  - `inviteUser(email: string, operator: string, reason: string): Promise<InviteResult>`
  - `createCourse(slug: string, title: string, operator: string, reason: string, imageDigest?: string): Promise<Course & { versions: CourseVersion[] }>`
  - `publishCourse(slug: string, operator: string, reason: string): Promise<CourseVersion>`
  - `enrollUser(email: string, courseSlug: string, operator: string, reason: string): Promise<Enrollment>`
  - `grantQuota(email: string, minutes: number, operator: string, reason: string): Promise<QuotaLedger>`

- [ ] **Step 1: 改测试，先加 AuditService mock 和一个失败断言**

把 `src/admin/admin.service.spec.ts` 整个替换成：

```typescript
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashOpaqueToken } from '../auth/tokens';
import { AdminService } from './admin.service';

const ENV_STUB = {
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: 'a'.repeat(48),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 3000,
  CORS_ORIGINS: 'tauri://localhost',
};

const buildPrisma = () => ({
  user: { upsert: jest.fn(), findUnique: jest.fn() },
  invitation: { create: jest.fn().mockResolvedValue({ id: 'inv_1' }) },
  course: { create: jest.fn(), findUnique: jest.fn() },
  courseVersion: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  enrollment: { create: jest.fn() },
  quotaLedger: { create: jest.fn() },
});

const buildService = async (
  prisma: ReturnType<typeof buildPrisma>,
  audit = { record: jest.fn() },
) => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: PrismaService, useValue: prisma },
      { provide: ENV, useValue: ENV_STUB },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { service: moduleRef.get(AdminService), audit };
};

const OPERATOR = 'ops@example.com';
const REASON = '封测名单批次 1';

describe('AdminService.inviteUser', () => {
  it('返回明文邀请码，但落库的是它的哈希，并写入审计', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'new@example.com',
    });
    const { service, audit } = await buildService(prisma);

    const result = await service.inviteUser('new@example.com', OPERATOR, REASON);

    expect(result.invitationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          tokenHash: hashOpaqueToken(result.invitationToken),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.OPERATOR, id: OPERATOR },
        action: 'admin.inviteUser',
        success: true,
        targetType: 'User',
        targetId: 'user_1',
        reason: REASON,
      }),
    );
  });

  it('重复邀请同一邮箱不会新建用户（upsert）', async () => {
    const prisma = buildPrisma();
    prisma.user.upsert.mockResolvedValue({
      id: 'user_1',
      email: 'dup@example.com',
    });
    const { service } = await buildService(prisma);

    await service.inviteUser('dup@example.com', OPERATOR, REASON);

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'dup@example.com' } }),
    );
  });
});

describe('AdminService.createCourse / publishCourse', () => {
  it('创建课程时一并建第一个 CourseVersion（version=1，未发布）', async () => {
    const prisma = buildPrisma();
    prisma.course.create.mockResolvedValue({
      id: 'course_1',
      slug: 'n8n',
      title: 'n8n 自动化工作流',
      versions: [{ id: 'cv_1', version: 1, publishedAt: null }],
    });
    const { service, audit } = await buildService(prisma);

    await service.createCourse('n8n', 'n8n 自动化工作流', OPERATOR, REASON);

    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'n8n',
          title: 'n8n 自动化工作流',
          versions: { create: { version: 1, imageDigest: null } },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.createCourse', success: true }),
    );
  });

  it('发布课程时给最新版本写 publishedAt', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue({
      id: 'cv_1',
      courseId: 'course_1',
      version: 1,
      publishedAt: null,
    });
    prisma.courseVersion.update.mockResolvedValue({
      id: 'cv_1',
      publishedAt: new Date(),
    });
    const { service, audit } = await buildService(prisma);

    await service.publishCourse('n8n', OPERATOR, REASON);

    expect(prisma.courseVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cv_1' },
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.publishCourse',
        targetType: 'CourseVersion',
        targetId: 'cv_1',
      }),
    );
  });

  it('重复发布同一版本是幂等的，不会二次写 publishedAt', async () => {
    const prisma = buildPrisma();
    const already = { id: 'cv_1', courseId: 'course_1', version: 1, publishedAt: new Date() };
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue(already);
    const { service } = await buildService(prisma);

    const result = await service.publishCourse('n8n', OPERATOR, REASON);

    expect(prisma.courseVersion.update).not.toHaveBeenCalled();
    expect(result).toBe(already);
  });

  it('课程没有任何版本时发布抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.course.findUnique.mockResolvedValue({ id: 'course_1', slug: 'n8n' });
    prisma.courseVersion.findFirst.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(service.publishCourse('n8n', OPERATOR, REASON)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminService 其余运营操作', () => {
  it('给不存在的用户发额度抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(
      service.grantQuota('ghost@example.com', 120, OPERATOR, REASON),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('给不存在的课程选课抛 NotFoundException', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    prisma.course.findUnique.mockResolvedValue(null);
    const { service } = await buildService(prisma);

    await expect(
      service.enrollUser('a@b.com', 'no-such-course', OPERATOR, REASON),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('发放额度写入 QuotaLedger 的正数流水，并带审计', async () => {
    const prisma = buildPrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'user_1', email: 'a@b.com' });
    prisma.quotaLedger.create.mockResolvedValue({
      id: 'ledger_1',
      userId: 'user_1',
      minutesDelta: 120,
    });
    const { service, audit } = await buildService(prisma);

    const entry = await service.grantQuota('a@b.com', 120, OPERATOR, REASON);

    expect(entry.minutesDelta).toBe(120);
    expect(prisma.quotaLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 'user_1', minutesDelta: 120 } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: AuditActorType.OPERATOR, id: OPERATOR },
        action: 'admin.grantQuota',
        targetType: 'QuotaLedger',
        targetId: 'ledger_1',
      }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认按预期失败**

```bash
npx jest src/admin/admin.service.spec.ts
```

预期：FAIL——`AdminService` 的五个方法这时候还是 Task 1 结束时的签名（没有 `operator`/`reason` 参数，也没有调用 `AuditService`），测试传了 3-4 个参数会跟方法定义的参数个数对不上，`audit.record` 断言会因为压根没被调用而失败。

- [ ] **Step 3: 实现新的 AdminService**

在 Task 1 已经建好的 `CourseVersion`/`QuotaLedger` 逻辑基础上，加 `operator`/`reason` 参数和 `audit.record()` 调用。把 `src/admin/admin.service.ts` 整个替换成：

```typescript
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, CourseVersion, Enrollment, QuotaLedger } from '@prisma/client';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
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
// 不要在 controller 里另写一份。每个写操作都要求调用方传 operator/reason，
// 由这里统一转成 AuditEvent——业务表本身不重复存这两个字段。
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  async inviteUser(
    email: string,
    operator: string,
    reason: string,
  ): Promise<InviteResult> {
    const user = await this.prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });

    const invitationToken = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + this.env.INVITATION_TTL_DAYS * DAY_MS,
    );

    await this.prisma.invitation.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(invitationToken),
        expiresAt,
      },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.inviteUser',
      success: true,
      targetType: 'User',
      targetId: user.id,
      reason,
    });

    // 明文只在这里返回一次，之后无法再取回。
    return { userId: user.id, email: user.email, invitationToken, expiresAt };
  }

  async createCourse(
    slug: string,
    title: string,
    operator: string,
    reason: string,
    imageDigest?: string,
  ): Promise<Course & { versions: CourseVersion[] }> {
    const course = await this.prisma.course.create({
      data: {
        slug,
        title,
        versions: { create: { version: 1, imageDigest: imageDigest ?? null } },
      },
      include: { versions: true },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.createCourse',
      success: true,
      targetType: 'Course',
      targetId: course.id,
      reason,
    });

    return course;
  }

  async publishCourse(
    slug: string,
    operator: string,
    reason: string,
  ): Promise<CourseVersion> {
    const course = await this.requireCourse(slug);
    const latest = await this.prisma.courseVersion.findFirst({
      where: { courseId: course.id },
      orderBy: { version: 'desc' },
    });
    if (!latest) {
      throw new NotFoundException(`课程 ${slug} 还没有任何版本`);
    }

    // 已经发布过就直接返回，不二次写 publishedAt——发布本身要是幂等操作。
    const published = latest.publishedAt
      ? latest
      : await this.prisma.courseVersion.update({
          where: { id: latest.id },
          data: { publishedAt: new Date() },
        });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.publishCourse',
      success: true,
      targetType: 'CourseVersion',
      targetId: published.id,
      reason,
    });

    return published;
  }

  async enrollUser(
    email: string,
    courseSlug: string,
    operator: string,
    reason: string,
  ): Promise<Enrollment> {
    const user = await this.requireUser(email);
    const course = await this.requireCourse(courseSlug);

    const enrollment = await this.prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.enrollUser',
      success: true,
      targetType: 'Enrollment',
      targetId: enrollment.id,
      reason,
    });

    return enrollment;
  }

  async grantQuota(
    email: string,
    minutes: number,
    operator: string,
    reason: string,
  ): Promise<QuotaLedger> {
    const user = await this.requireUser(email);

    const entry = await this.prisma.quotaLedger.create({
      data: { userId: user.id, minutesDelta: minutes },
    });

    await this.audit.record({
      actor: { type: AuditActorType.OPERATOR, id: operator },
      action: 'admin.grantQuota',
      success: true,
      targetType: 'QuotaLedger',
      targetId: entry.id,
      reason,
    });

    return entry;
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

- [ ] **Step 4: 跑测试确认通过**

```bash
npx jest src/admin/admin.service.spec.ts
```

预期：PASS，9 个测试全过。

- [ ] **Step 5: 只跑受影响的单元测试，不跑全量 lint/build**

`AdminService` 五个方法的参数个数变了（多了 `operator`/`reason`），而 `src/admin/commands/*.command.ts` 四个文件还在用 Task 1 时的调用方式（少两个参数）——这是真实的 TS 参数个数不匹配，`npm run build`（`nest build` 会检查整个 `src` 目录）和 `npm run lint`（typescript-eslint 同样是全项目类型检查）在这一步**都会报错**，不是假象，是因为 CLI 命令文件还没改，Task 5 才会改。这一步不跑这两个全量命令，只跑这次改到的和没改到但会被间接加载的测试文件，确认 `AdminService` 自己的逻辑是对的：

```bash
npx jest src/admin src/audit src/auth
```

预期：全部 PASS（`src/admin/commands/*.command.ts` 不是 `*.spec.ts`，不会被 Jest 收集，所以这条命令不会因为命令文件的参数不匹配而失败）。

- [ ] **Step 6: Commit**

```bash
git add src/admin/admin.service.ts src/admin/admin.service.spec.ts
git commit -m "feat: AdminService 加 operator/reason 与审计"
```

---

## Task 5: 运营 CLI 加 --operator/--reason/--execute 与结构化输出

**Files:**
- Create: `src/admin/admin.schemas.ts`
- Create: `src/admin/admin.schemas.spec.ts`
- Modify: `src/admin/commands/invite.command.ts`
- Modify: `src/admin/commands/course.command.ts`
- Modify: `src/admin/commands/enroll.command.ts`
- Modify: `src/admin/commands/quota.command.ts`

**Interfaces:**
- Consumes：Task 4 的新 `AdminService` 方法签名
- Produces：无（CLI 命令是最外层，不被其它任务消费）

- [ ] **Step 1: 写 admin.schemas.ts 的失败测试**

创建 `src/admin/admin.schemas.spec.ts`：

```typescript
import { OperatorSchema, ReasonSchema } from './admin.schemas';

describe('OperatorSchema', () => {
  it('接受合法邮箱', () => {
    expect(OperatorSchema.parse('ops@example.com')).toBe('ops@example.com');
  });

  it('拒绝非邮箱字符串', () => {
    expect(() => OperatorSchema.parse('not-an-email')).toThrow();
  });
});

describe('ReasonSchema', () => {
  it('接受非空字符串', () => {
    expect(ReasonSchema.parse('封测名单批次 1')).toBe('封测名单批次 1');
  });

  it('拒绝空字符串', () => {
    expect(() => ReasonSchema.parse('')).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx jest src/admin/admin.schemas.spec.ts
```

预期：FAIL，`Cannot find module './admin.schemas'`。

- [ ] **Step 3: 实现 admin.schemas.ts**

```typescript
import { z } from 'zod';

export const OperatorSchema = z.email('operator 必须是合法邮箱');
export const ReasonSchema = z.string().min(1, 'reason 不能为空');
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx jest src/admin/admin.schemas.spec.ts
```

预期：PASS，4 个测试。

- [ ] **Step 5: 改 invite.command.ts**

```typescript
import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface InviteOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'invite',
  arguments: '<email>',
  description: '邀请一个封测用户',
})
export class InviteCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: InviteOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const email = inputs[0];

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'invite',
          dryRun: true,
          operator,
          reason,
          email,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const result = await this.admin.inviteUser(email, operator, reason);

    console.log(
      JSON.stringify({
        command: 'invite',
        dryRun: false,
        operator,
        reason,
        email: result.email,
        invitationToken: result.invitationToken,
        expiresAt: result.expiresAt.toISOString(),
      }),
    );
  }

  @Option({
    flags: '-o, --operator <operator>',
    description: '执行本次操作的人（邮箱）',
    required: true,
  })
  parseOperator(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --reason <reason>',
    description: '本次操作的原因',
    required: true,
  })
  parseReason(val: string): string {
    return val;
  }

  @Option({
    flags: '-e, --execute',
    description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）',
  })
  parseExecute(): boolean {
    return true;
  }
}
```

- [ ] **Step 6: 改 course.command.ts**

```typescript
import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface CourseCreateOptions {
  operator: string;
  reason: string;
  execute?: boolean;
  imageDigest?: string;
}

@Command({
  name: 'course:create',
  arguments: '<slug> <title>',
  description: '新建课程（同时建第一个未发布的版本）',
})
export class CourseCreateCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: CourseCreateOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [slug, title] = inputs;

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'course:create',
          dryRun: true,
          operator,
          reason,
          slug,
          title,
          imageDigest: options.imageDigest ?? null,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const course = await this.admin.createCourse(
      slug,
      title,
      operator,
      reason,
      options.imageDigest,
    );

    console.log(
      JSON.stringify({
        command: 'course:create',
        dryRun: false,
        operator,
        reason,
        slug: course.slug,
        title: course.title,
        version: course.versions[0]?.version,
      }),
    );
  }

  @Option({ flags: '-o, --operator <operator>', description: '执行本次操作的人（邮箱）', required: true })
  parseOperator(val: string): string {
    return val;
  }

  @Option({ flags: '-r, --reason <reason>', description: '本次操作的原因', required: true })
  parseReason(val: string): string {
    return val;
  }

  @Option({ flags: '-e, --execute', description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）' })
  parseExecute(): boolean {
    return true;
  }

  @Option({ flags: '-i, --image-digest <imageDigest>', description: 'VM 镜像摘要，Labs 集成前可以不填' })
  parseImageDigest(val: string): string {
    return val;
  }
}

interface CoursePublishOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'course:publish',
  arguments: '<slug>',
  description: '发布课程的最新版本',
})
export class CoursePublishCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: CoursePublishOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const slug = inputs[0];

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'course:publish',
          dryRun: true,
          operator,
          reason,
          slug,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const version = await this.admin.publishCourse(slug, operator, reason);

    console.log(
      JSON.stringify({
        command: 'course:publish',
        dryRun: false,
        operator,
        reason,
        slug,
        version: version.version,
        publishedAt: version.publishedAt?.toISOString(),
      }),
    );
  }

  @Option({ flags: '-o, --operator <operator>', description: '执行本次操作的人（邮箱）', required: true })
  parseOperator(val: string): string {
    return val;
  }

  @Option({ flags: '-r, --reason <reason>', description: '本次操作的原因', required: true })
  parseReason(val: string): string {
    return val;
  }

  @Option({ flags: '-e, --execute', description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）' })
  parseExecute(): boolean {
    return true;
  }
}
```

- [ ] **Step 7: 改 enroll.command.ts**

```typescript
import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface EnrollOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'enroll',
  arguments: '<email> <courseSlug>',
  description: '给用户开课',
})
export class EnrollCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: EnrollOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [email, courseSlug] = inputs;

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'enroll',
          dryRun: true,
          operator,
          reason,
          email,
          courseSlug,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    await this.admin.enrollUser(email, courseSlug, operator, reason);

    console.log(
      JSON.stringify({
        command: 'enroll',
        dryRun: false,
        operator,
        reason,
        email,
        courseSlug,
      }),
    );
  }

  @Option({ flags: '-o, --operator <operator>', description: '执行本次操作的人（邮箱）', required: true })
  parseOperator(val: string): string {
    return val;
  }

  @Option({ flags: '-r, --reason <reason>', description: '本次操作的原因', required: true })
  parseReason(val: string): string {
    return val;
  }

  @Option({ flags: '-e, --execute', description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）' })
  parseExecute(): boolean {
    return true;
  }
}
```

- [ ] **Step 8: 改 quota.command.ts**

```typescript
import { Command, CommandRunner, Option } from 'nest-commander';
import { AdminService } from '../admin.service';
import { OperatorSchema, ReasonSchema } from '../admin.schemas';

interface QuotaGrantOptions {
  operator: string;
  reason: string;
  execute?: boolean;
}

@Command({
  name: 'quota:grant',
  arguments: '<email> <minutes>',
  description: '给用户发放运行额度（分钟）',
})
export class QuotaGrantCommand extends CommandRunner {
  constructor(private readonly admin: AdminService) {
    super();
  }

  async run(inputs: string[], options: QuotaGrantOptions): Promise<void> {
    const operator = OperatorSchema.parse(options.operator);
    const reason = ReasonSchema.parse(options.reason);
    const [email, minutesRaw] = inputs;
    const minutes = Number.parseInt(minutesRaw, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new Error(`分钟数必须是正整数，收到：${minutesRaw}`);
    }

    if (!options.execute) {
      console.log(
        JSON.stringify({
          command: 'quota:grant',
          dryRun: true,
          operator,
          reason,
          email,
          minutes,
          note: '加 --execute 才会真正写库',
        }),
      );
      return;
    }

    const entry = await this.admin.grantQuota(email, minutes, operator, reason);

    console.log(
      JSON.stringify({
        command: 'quota:grant',
        dryRun: false,
        operator,
        reason,
        email,
        minutesDelta: entry.minutesDelta,
      }),
    );
  }

  @Option({ flags: '-o, --operator <operator>', description: '执行本次操作的人（邮箱）', required: true })
  parseOperator(val: string): string {
    return val;
  }

  @Option({ flags: '-r, --reason <reason>', description: '本次操作的原因', required: true })
  parseReason(val: string): string {
    return val;
  }

  @Option({ flags: '-e, --execute', description: '真正执行写库；不加这个参数只打印将要发生的变更（dry-run）' })
  parseExecute(): boolean {
    return true;
  }
}
```

- [ ] **Step 9: 全量 lint + build + test**

```bash
npm run lint && npm run build && npm test
```

预期：全绿——这是 Global Constraints 里说的「Task 1 到 Task 5 之间全量命令会报错」窗口期结束的验证点：四个命令文件到 Step 8 为止都已经改完，第一次能重新跑通全量 lint/build/test。

- [ ] **Step 10: e2e 验证**

```bash
npm run test:e2e
```

预期：3 个套件全绿（`test/auth.e2e-spec.ts` 会真的往 `AuditEvent` 表写数据，不需要额外改动就能过，因为 `AuthService` 的公开方法签名没变）。

- [ ] **Step 11: 手动验证 dry-run 和 execute 两条路径**

```bash
npm run cli -- invite pilot-b@example.com --operator ops@example.com --reason "计划 B 手动验证"
```

预期：打印一行 JSON，`"dryRun":true`，没有 `invitationToken` 字段。

```bash
npm run cli -- invite pilot-b@example.com --operator ops@example.com --reason "计划 B 手动验证" --execute
```

预期：打印一行 JSON，`"dryRun":false`，带 `invitationToken`/`expiresAt`。

```bash
npm run cli -- invite pilot-b@example.com
```

预期：命令报错退出（缺少必填的 `--operator`/`--reason`），不是静默用空值执行。

- [ ] **Step 12: Commit**

```bash
git add src/admin/admin.schemas.ts src/admin/admin.schemas.spec.ts src/admin/commands
git commit -m "feat: 运营 CLI 加 operator/reason/dry-run 与结构化输出"
```

---

## 完成标准

1. `npm run lint && npm run build && npm test` 全绿，单元测试不依赖数据库
2. `docker compose up -d && npm run test:e2e` 全绿（4 个套件：health、app、auth、schema）
3. 手动验证：`npm run cli -- invite <email> --operator <op> --reason <r>` 不加 `--execute` 只打印、不写库；加 `--execute` 真正写库；不带 `--operator`/`--reason` 直接报错退出
4. Prisma schema 里能看到 `CourseVersion`/`Workspace`/`Progress`/`Attempt`/`Conversation`/`QuotaLedger`/`AuditEvent` 七个模型（`grep -n "^model" prisma/schema.prisma` 应该输出 10 个 model）
5. `AuthService` 的 `acceptInvitation`/`login`/`refresh`/`logout` 在成功和失败路径上都调用了 `AuditService.record`（`logout` 的幂等空操作分支除外，这是有意排除的）
6. **不做**：CI 配置（`.github/workflows` 等）、SRV-007/009/010/012/013/014/015 对应的任何读接口或业务逻辑
