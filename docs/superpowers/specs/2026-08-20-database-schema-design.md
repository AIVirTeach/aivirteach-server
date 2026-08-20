# 数据库 Schema 设计：一次性覆盖全部 Control Plane 表

## 背景

server 的 Postgres 是整个产品唯一的数据库——client（Tauri / Next.js）没有自己的 DB（`aivirteach-client` 的
`db/schema.ts` 是空文件），Labs 也没有对外的持久化服务，只有 `course.json` 之类的内容文件和一个管 VM
生命周期的 HTTP 接口。这份 schema 必须同时装下两类需求：

1. **client 需要读写的一切**——契约来源是 `aivirteach-client` `main` 分支的 `app/lib/api.ts`。
2. **server 驱动 Labs 需要落库的一切**——摄取课程内容（`course.json`）、起停 VM
   （`service.py`）、拼诊断请求（`aivirteach_agent/models.py`）。

起因是 `course:create` / `course:publish` 这两个已存在的 CLI 命令（`src/admin/commands/course.command.ts`）
目前只是空壳：`createCourse` 只写 slug/title，`CourseVersion.content` 永远是 `{}`，从没读过 Labs 的
`course.json`；client 登录后 dashboard/courses 什么都看不到，因为 server 除了 auth 什么都没实现。这次要一次性把
全部 Control Plane 模块（不只是课程）需要的表都设计出来，不要做完课程又发现漏了别的模块。

## 关键事实核对（不是从架构文件抄来的，是直接读代码/开 `gh`/`git` 核对的）

- **`aivirteach-client` `main`**：2026-08-19 被 PR #1 合并了 `FrontEnd-v0` 的全部内容，不再是占位 README。
  合并后的 `main` 自己的 README 写明："The deployed control plane currently exposes health and
  invitation-based JWT authentication... Dashboard, courses, progress, and chat routes are not yet exposed
  by that server, so authenticated users see the frontend's local demo learning data for those areas."——
  也就是说 `app/lib/api.ts` 那 14 个端点是 client 正在等的**真实契约**，不是 2026-08-11 架构文件里说的
  "Codex 建站模板生成的 public demo，不作为实现依据"。那个判断是合并之前写的，已经过期。
- **`aivirteach-labs` `main`**：2026-08-20 被 PR #1（`agent`）和 PR #2（`vm_module`）合并，同样不再是占位
  README。`service.py`（318 行，真实 FastAPI 服务，不是文档 stub）实现了完整的 VM 生命周期：
  `POST /v1/vms`、`GET /v1/vms/{lab_id}/{status,ip,vnc,credentials}`、
  `POST /v1/vms/{lab_id}/actions/{start,stop,force-stop,reboot}`、`DELETE /v1/vms/{lab_id}`。
  `docs_gateway_service.py` 仍然只有 7 行，是真 stub。
- **`POST /v1/vms` 是同步阻塞调用**（`CREATE_TIMEOUT_SECONDS=180`），跑完 `create-learner-vm.sh` 脚本才返回
  `{lab_id, username, rdp_password, rdp_port:3389, ...}`。架构文件场景 B 画的"Labs watcher 回推 RUNNING"
  在真实代码里不存在——server 侧的 BullMQ worker 打这一次阻塞调用、拿到结果就落库+推 WS，不需要额外的回推
  机制。这跟决策 #3（客户端绝不同步等）不冲突，因为阻塞的是 worker，不是给客户端的 HTTP 响应。
- 真实的桌面协议是 **RDP**（`vm_vlient` 分支的 Tauri + Rust IronRDP），不是架构文件决策 #1①里讨论的
  noVNC/KubeVirt；架构文件自己也已经把这个差距记录清楚："协议侧 XRDP+Guacamole 与 noVNC 都能满足决策
  #5 的发票模型"，"这是 Labs 的内部实现，不是 server 的决策项"，server 只认 5 个动作 + `status` 返回
  `{status, ip, rdpPort}`。

## 设计原则

1. **契约来源**：client 要什么字段，去 `api.ts` 查；server 要给 Labs 传什么/存什么，去 `course.json` /
   `models.py` / `service.py` 查。两边都没有出现的字段不建（见"不建表"一节）。
2. **能现算的不落库**：`streakDays`、`weeklyHours`、`skillsMastered`、`Enrollment.progressPercent` 都是读
   dashboard/enrollment 时从 `Activity`/`PracticeSession`/`Progress` 现算，不额外维护冗余计数器。
3. **Console Session（一次性发票）不进 Postgres**：TTL 60s、一次性 jti、绑
   `workspaceId+userId+VM` 的签发/校验逻辑，jti 去重靠 Redis（`docker-compose.yml` 已经起了 Redis 容器，
   `package.json` 还没接 `ioredis`/`bullmq`，`.env.example` 也没有 `REDIS_URL`——基建在，代码没接，这是另一块
   独立工作，不进这次 schema）。
4. **Workspace 按真实的 `service.py` 接口设计**，不是按架构文件想象中的 noVNC/gRPC 设计。
5. **Lesson/Assessment 变成真表后，原来的裸 `Int` 索引全部换成外键**——`Progress.currentStep` →
   `currentLessonId`，`Attempt.stepIndex` → `assessmentId`。

## 完整 Prisma Schema

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
  DESTROYED
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

enum Plan {
  FREE
  PREMIUM
}

enum CourseLevel {
  BEGINNER
  INTERMEDIATE
  ADVANCED
}

enum ActivityKind {
  LESSON
  PRACTICE
  ACHIEVEMENT
}

enum ExportStatus {
  PENDING
  PACKAGING
  READY
  FAILED
}

model User {
  id           String     @id @default(cuid())
  email        String     @unique
  displayName  String?
  passwordHash String?
  status       UserStatus @default(INVITED)
  role         String     @default("Learner")
  plan         Plan       @default(FREE)
  level        Int        @default(1)
  timezone     String     @default("Asia/Kuala_Lumpur")
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  invitations      Invitation[]
  refreshTokens    RefreshToken[]
  enrollments      Enrollment[]
  quotaLedgers     QuotaLedger[]
  notifications    Notification[]
  practiceSessions PracticeSession[]
  activities       Activity[]
}

model Invitation {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
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
  replacedBy String?
  createdAt  DateTime  @default(now())

  @@index([userId])
}

// 只放目录级字段；modules/lessons/welcome/assessment 内容随版本迭代，见下面几张表。
model Course {
  id              String      @id @default(cuid())
  slug            String      @unique
  contentId       String?     @unique
  title           String
  shortTitle      String?
  category        String      @default("")
  description     String      @default("")
  level           CourseLevel @default(BEGINNER)
  language        String      @default("en")
  durationMinutes Int         @default(0)
  lessonCount     Int         @default(0)
  tags            String[]    @default([])
  outcomes        String[]    @default([])
  requirements    String[]    @default([])
  published       Boolean     @default(false)
  coverAssetId    String?
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  versions    CourseVersion[]
  enrollments Enrollment[]
  assets      CourseAsset[]
}

model CourseAsset {
  id        String   @id @default(cuid())
  courseId  String
  course    Course   @relation(fields: [courseId], references: [id], onDelete: Cascade)
  type      String
  objectKey String
  altText   String?
  mimeType  String?
  createdAt DateTime @default(now())

  @@index([courseId])
}

// course:create / course:publish 摄取 Labs course.json 时一次性写入这几张表，
// 替代原来 content:Json 大杂烩的做法。sourceMarkdown 是摄取时把 source.path 指向的
// 原始文件整份读进来存好；每个 Lesson 用自己的 sourceRange 从这份全文里现切，不重复存。
model CourseVersion {
  id                    String    @id @default(cuid())
  courseId              String
  course                Course    @relation(fields: [courseId], references: [id], onDelete: Cascade)
  version               Int
  imageDigest           String?
  sourceFormat          String?
  sourcePath            String?
  sourceEncoding        String?
  sourceMarkdown        String?   @db.Text
  introSourceRange      Json?
  introFeaturedAssetIds String[]  @default([])
  publishedAt           DateTime?
  createdAt             DateTime  @default(now())

  modules     CourseModule[]
  welcome     CourseWelcome?
  enrollments Enrollment[]

  @@unique([courseId, version])
  @@index([courseId])
}

model CourseModule {
  id               String        @id @default(cuid())
  courseVersionId  String
  courseVersion    CourseVersion @relation(fields: [courseVersionId], references: [id], onDelete: Cascade)
  position         Int
  title            String
  description      String
  estimatedMinutes Int

  lessons     CourseLesson[]
  enrollments Enrollment[]

  @@unique([courseVersionId, position])
  @@index([courseVersionId])
}

model CourseLesson {
  id                     String       @id @default(cuid())
  moduleId               String
  module                 CourseModule @relation(fields: [moduleId], references: [id], onDelete: Cascade)
  position               Int
  title                  String
  estimatedMinutes       Int
  objectives             String[]     @default([])
  sourceRange            Json
  activityType           String
  activityPrompt         String
  activityCompletionType String
  // course.json 里已有的引用；assessments.json 到货前，这些 id 可能还没有对应的 LessonAssessment 行。
  assessmentIds          String[]     @default([])

  assessments LessonAssessment[]
  progresses  Progress[]

  @@unique([moduleId, position])
  @@index([moduleId])
}

// 结构由 client 的 ApiCourseWelcome 类型确定；welcome.json 目前在 Labs 仓库里还不存在，
// 表先建好，等数据到货后摄取填充。
model CourseWelcome {
  id                 String        @id @default(cuid())
  courseVersionId    String        @unique
  courseVersion      CourseVersion @relation(fields: [courseVersionId], references: [id], onDelete: Cascade)
  overviewAssetId    String?
  overviewHeading    String?
  overviewParagraphs String[]      @default([])
  // 每一步的具体字段形状（title/description 等）在 welcome.json 落地前不确定，先留 Json。
  howItWorksSteps    Json?
  finalOutcome       String?
}

// 两层可见性合一张表：client 只拿 clientCriteria 那部分；expectedResult/successCriteria/
// commonFailures 拼进发给 Labs /v1/agent/diagnose 的 LessonContext，绝不吐给 client。
model LessonAssessment {
  id              String       @id @default(cuid())
  lessonId        String
  lesson          CourseLesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)
  type            String
  question        String
  options         String[]     @default([])
  clientCriteria  String[]     @default([])
  expectedResult  String?
  successCriteria String[]     @default([])
  commonFailures  String[]     @default([])

  attempts Attempt[]

  @@index([lessonId])
}

model Enrollment {
  id              String         @id @default(cuid())
  userId          String
  courseId        String
  courseVersionId String?
  currentModuleId String?
  user            User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  course          Course         @relation(fields: [courseId], references: [id], onDelete: Cascade)
  courseVersion   CourseVersion? @relation(fields: [courseVersionId], references: [id])
  currentModule   CourseModule?  @relation(fields: [currentModuleId], references: [id])
  active          Boolean        @default(true)
  createdAt       DateTime       @default(now())

  workspace     Workspace?
  progress      Progress?
  attempts      Attempt[]
  conversations Conversation[]
  activities    Activity[]
  completion    EnrollmentCompletion?

  @@unique([userId, courseId])
  @@index([courseId])
  @@index([courseVersionId])
  @@index([currentModuleId])
}

// 字段和调用顺序都对着 labs main 上真实的 service.py 核对过：
// ip 要单独调 GET /ip 才有（create 响应里没有）；rdpPort/rdpUsername 是 POST /v1/vms
// 创建响应直接给的；labsRawStatus 只摘 GET /status 返回的 dominfo 里的 State 字段，仅调试；
// vncPort 对应真实存在的 GET /vnc，目前两个 client 都走 RDP，暂时没有消费方。
model Workspace {
  id            String          @id @default(cuid())
  enrollmentId  String          @unique
  enrollment    Enrollment      @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  status        WorkspaceStatus @default(CREATING)
  errorMessage  String?
  labId         String?         @unique
  labsRawStatus String?
  ip            String?
  rdpPort       Int?
  rdpUsername   String?
  vncPort       Int?
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt
}

model Progress {
  id              String        @id @default(cuid())
  enrollmentId    String        @unique
  enrollment      Enrollment    @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  currentLessonId String?
  currentLesson   CourseLesson? @relation(fields: [currentLessonId], references: [id])
  updatedAt       DateTime      @updatedAt

  @@index([currentLessonId])
}

model Attempt {
  id           String           @id @default(cuid())
  enrollmentId String
  enrollment   Enrollment       @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  assessmentId String
  assessment   LessonAssessment @relation(fields: [assessmentId], references: [id])
  status       AttemptStatus
  exitCode     Int?
  // 评测的原始 stdout，不截断；不单独存一个脱离证据的 passed:true。
  stdout       String?
  fileHash     String?
  createdAt    DateTime         @default(now())

  @@index([enrollmentId, assessmentId])
}

model Conversation {
  id           String           @id @default(cuid())
  enrollmentId String
  enrollment   Enrollment       @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  threadId     String
  role         ConversationRole
  content      String
  // 拼给 Labs /v1/agent/diagnose 的素材（当前步骤、截图、评测结果等）。
  contextRef   Json?
  createdAt    DateTime         @default(now())

  @@index([enrollmentId, threadId])
}

model Notification {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  message   String
  readAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}

model PracticeSession {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  minutes   Int
  createdAt DateTime @default(now())

  @@index([userId, createdAt])
}

model Activity {
  id           String       @id @default(cuid())
  userId       String
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  enrollmentId String?
  enrollment   Enrollment?  @relation(fields: [enrollmentId], references: [id], onDelete: SetNull)
  kind         ActivityKind
  title        String
  detail       String
  occurredAt   DateTime     @default(now())

  @@index([userId, occurredAt])
}

model QuotaLedger {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  minutesDelta Int
  expiresAt    DateTime?
  createdAt    DateTime  @default(now())

  @@index([userId])
}

model AuditEvent {
  id         String         @id @default(cuid())
  actorType  AuditActorType
  actorId    String?
  action     String
  success    Boolean
  targetType String?
  targetId   String?
  reason     String?
  metadata   Json?
  createdAt  DateTime       @default(now())

  @@index([actorId])
  @@index([action])
}

// 架构文件模块网格里的"总结与导出编排"（SRV-016 · LAB-015），之前完全没建。
model EnrollmentCompletion {
  id              String       @id @default(cuid())
  enrollmentId    String       @unique
  enrollment      Enrollment   @relation(fields: [enrollmentId], references: [id], onDelete: Cascade)
  summary         String?
  exportStatus    ExportStatus @default(PENDING)
  exportObjectKey String?
  exportFileHash  String?
  errorMessage    String?
  completedAt     DateTime     @default(now())
  exportedAt      DateTime?
}
```

## 不建表（demo-only，找不到真实数据源）

achievements 成就墙、技能雷达图（`skills[]`）、AI 洞察文案（`analytics.insight` 之类）——这些只在
`aivirteach-client` 的 `mock-profile.ts` 本地演示数据里出现，`api.ts` 真实契约类型里没有对应字段，三个仓库
里也找不到任何真实数据源或计算逻辑。

## 迁移策略

现在的开发 DB 已经有真实登录数据（User/Invitation/RefreshToken），但这次改动包含破坏性变更
（`CourseVersion.content:Json` 整个拿掉、`Progress.currentStep`/`Attempt.stepIndex` 从 Int 换成外键）。
决定：**直接 `npx prisma migrate reset`**，不写保留数据的迁移脚本或回填逻辑——现有数据只是测试登录账号，
还没有真实课程内容，重新邀请几个测试账号成本很低。reset 后用现有的 `invite` CLI 命令重新种测试账号。

## 修订记录

- 2026-08-20（写实施计划时发现）：`Course` 补了 `outcomes String[]` / `requirements String[]`——
  这两个字段在真实 `course.json`（顶层 `outcomes`/`requirements`）和 client 的 `ApiCourseDetail`
  类型里都存在，前几轮讨论 schema 时漏收了，跟 `tags` 放在同一张表、同一层级。
- 2026-08-20（同上）：`LessonAssessment.options` 从 `Json?` 改成 `String[]`，`clientCriteria` 从
  `String?` 改成 `String[]`——对齐 `api.ts` 里 `ApiLesson.assessment` 的真实类型
  `{options?: string[], criteria?: string[]}`，两个都是字符串数组，不是单值/JSON。Prisma 的
  scalar list 字段本身不可为 null，空数组就表示"没有这个东西"，所以都用 `@default([])`。

## 已知缺口 / 未决项

- `CourseWelcome.howItWorksSteps` 的具体字段形状（`welcome.json` 落地前不确定），先留 `Json`。
- `CourseLesson.assessmentIds` 目前照抄 `course.json` 的引用，指向的 `LessonAssessment` 行在
  `assessments.json` 到货前还不存在——暂时不加硬外键约束，等数据到货后再考虑收紧。
- `Workspace.vncPort` 目前没有任何消费方（两个 client 都走 RDP），先留字段位置。

## 后续工作（这次范围之外，留给以后排期）

- **client PR：把 courses/lesson 那块从本地 mock 换成真实调用**——`aivirteach-client` 的
  `useMockCourseProgress.ts` / `mock-course.ts` 是纯 `localStorage` 实现，从没调用过 `api.*`；
  `courses/page.tsx`、`python-basics/page.tsx`、`analysis/v2/page.tsx` 都直接依赖它。这个 PR 要等 server
  的 `courses`/`enrollments`/`lessons`/`assessment` 这些 endpoint 真正上线之后再排期，把这几个页面换成
  `api.courses()` / `api.enrollments()` / `api.lesson()` / `api.submitAssessment()`，才能删掉
  `mock-course.ts`。
  - dashboard/notifications 那块不需要额外的 client PR——`useLearnerProfile.ts` 已经是"先打真实
    `/dashboard`+`/notifications`，只有 404 才 fallback 到 `mock-profile.ts`"的逻辑，server 一实现这两个
    endpoint，fallback 自己就不会再触发。
- Console Session 的签发/校验逻辑（短期一次性票 + Redis jti 去重）——对应 SRV-011，这次 schema 不涉及，
  Redis 基建已经在 `docker-compose.yml` 里但应用层还没接（`package.json` 没有 `ioredis`/`bullmq`，
  `.env.example` 没有 `REDIS_URL`）。
- `assessments.json` / `welcome.json` 到货后：摄取填充 `CourseWelcome`/`LessonAssessment`，重新考虑
  `CourseLesson.assessmentIds` 要不要收紧成真外键约束。

## 参考来源

- `docs/educationproject/2026-08-11-aivirteach-technical-architecture.html`（架构决策 + Control Plane
  模块网格；"实施现状"一节记录的部分事实已被本文档开头"关键事实核对"更新）
- `aivirteach-client` `main`（2026-08-19 PR #1 合并后）：`app/lib/api.ts`、`app/lib/mock-profile.ts`、
  `app/lib/mock-course.ts`、`app/hooks/useLearnerProfile.ts`、`app/hooks/useMockCourseProgress.ts`、
  `app/lib/config.ts`
- `aivirteach-labs` `main`（2026-08-20 PR #1/#2 合并后）：`course.json`、`service.py`、
  `aivirteach_agent/models.py`、`AGENT.md`
- `aivirteach-server` 现有 `prisma/schema.prisma`（`feat/srv-course-catalog-schema` 分支）、
  `src/admin/commands/course.command.ts`、`src/admin/admin.service.ts`
