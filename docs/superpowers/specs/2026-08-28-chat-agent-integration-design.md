# AIVir Teacher 聊天集成设计：把 client 已建好的聊天面板接到 Labs 诊断 Agent

## 背景

`/workspace` 页面右侧一直有一个"AIVir Teacher"聊天面板（`aivirteach-client` `app/workspace/page.tsx`），UI 和 `api.ts` 里的 `chatMessages`/`sendChatMessage` 早就写好了，调用 `GET/POST /chat/threads/:threadId/messages`——但 `aivirteach-server` 从来没实现过这两个接口，`app.module.ts` 里没有任何 Chat 相关 module，调用会直接 404，client 的 catch 块把这个失败悄悄渲染成"The tutor is unavailable."，看起来像功能，其实是空壳。

与此同时，`aivirteach-labs` 的 `main` 分支上有一个独立、已经写完的 FastAPI 服务 `agent-service`（`aivirteach_agent` 包）：一个有边界的、只读的、课程感知的 VM 故障诊断 agent，暴露 `POST /v1/agent/diagnose`，真实接了 DeepSeek（`openai_compatible` provider），不是 stub。这次会话里用真实 token 直接打过这个接口（`connectivity-test-001` 测试 lab_id + "docker install 卡住"的问题），确认了：认证、请求校验、orchestrator、LLM 调用、结构化响应全部真实工作，`tool_trace`/`limitations` 字段也如实反映了工具调用失败（`GATEWAY_UNAVAILABLE`）的情况。

这份设计要做的，是把这两块已经分别存在、但从未连起来的东西"transport"打通：client 聊天面板 → server 新增的 Chat 模块 → Labs 的诊断 Agent。**Agent 内部怎么诊断、用什么工具、prompt 怎么写，是 `aivirteach-labs` 的范围，这次不碰。**

## 关键事实核对

- `prisma/schema.prisma` 里已经有一张没被任何代码用过的 `Conversation` 表（`enrollmentId` / `threadId` / `role: USER|ASSISTANT|SYSTEM` / `content` / `contextRef: Json?`），字段注释原话是"拼给 Labs /v1/agent/diagnose 的素材（当前步骤、截图、评测结果等）"——这次的集成方向在 schema 设计阶段（`docs/superpowers/specs/2026-08-20-database-schema-design.md`）就已经被预见到了，只是从未落地成 controller/service。
- `LessonAssessment` 表的 `expectedResult`/`successCriteria`/`commonFailures` 字段注释同样明确："client 只拿 clientCriteria 那部分；expectedResult/successCriteria/commonFailures 拼进发给 Labs /v1/agent/diagnose 的 LessonContext，绝不吐给 client"——这条"别把标准答案泄露给学生"的安全约束是已有设计决策，这次直接继承，不重新讨论。
- `agent-service` 的 `POST /v1/agent/diagnose`（`aivirteach_agent/models.py`）要求请求体带 `request_id`（UUID）、`lab_id`、`question`、`course`（`CourseContext`: course_id/version/title/summary/relevant_excerpts）、`current_step`（`LessonContext`: module_id/lesson_id/sequence/title/summary/instructions/expected_result/success_criteria/common_failures），`diagnostic_scope`/`history` 可选；另外还有 `response_language`（默认 `"zh-CN"`）、`learner_state`（默认空 dict）两个有默认值的可选字段，这次不主动填。这是个 `extra="forbid"` 的严格 Pydantic 模型，字段名、长度、pattern 都有硬校验，不能随便拼——尤其是 `LessonContext.common_failures`，类型是 `list[CommonFailure]`（`{code: str, symptoms: list[str]}` 对象数组，`code` 非空必填），跟 Prisma `LessonAssessment.commonFailures: String[]`（纯字符串数组）不是同一个形状，不能直接透传，转换方式见下方"组件设计"。
- server 现有课程数据链路 `Course → CourseVersion → CourseModule → CourseLesson → LessonAssessment` 的字段基本能拼出 `CourseContext`/`LessonContext`；"当前步骤"应该读 `Progress.currentLessonId`（`enrollments.service.ts` 里完成课时会更新它），**不是** `Enrollment.currentModuleId`——后者只在重开课程时被置 `null`，之后从未被其他代码更新过，是个死字段。
- `courses.service.ts` 里有条注释确认：`LessonAssessment` 行要等 Labs 的 `assessments.json` 落地才会存在，这轮之前固定返回 `null`。也就是说 `expected_result`/`success_criteria`/`common_failures` 这部分 grounding 数据目前基本是空的，是上游数据缺口，不是这次设计要解决的问题。
- 实测 `agent-service` 的 `/ready` 返回 `"processed_courses":0`——课程内容还没跑 `process_course.py` 摄取管线，Agent 侧目前没有额外的课程 grounding 数据可用，纯靠请求体里传的 `CourseContext`/`LessonContext` + 通用推理 + 实时 VM 工具查证。
- `AIVIRTEACH_AGENT_TOKEN` 是 server-to-Agent 的共享密钥（`agent-service/aivirteach_agent/app.py` 的 `require_agent_token`，HMAC 常量时间比较），跟现有 `AIVIRTEACH_API_TOKEN` 一样是"两边变量名相同、值抄一份"的模式,不需要新的密钥体系。
- Agent 服务当前通过同事手动起的 `cloudflared` quick tunnel（`*.trycloudflare.com`）对外暴露，这类地址每次同事重启隧道就会变——跟现有 `LABS_VM_BASE_URL`/`LABS_GUACAMOLE_BASE_URL` 面临的是同一个已知运维问题，这次不解决，沿用现有"手动更新 Vercel 环境变量"的处理方式。

## 不做的事（明确排除的范围）

- **不碰 `agent-service` 内部实现**——prompt、工具集、`DiagnosticGateway`、`course_repository` 的摄取逻辑都是 `aivirteach-labs` 的范围。
- **不做多轮"会话线程"切换**——`Conversation.threadId` 列继续存在（满足 schema 的 NOT NULL），但这轮就存 `enrollmentId` 的值，一个 enrollment 一条连续历史，不在 API/URL 语义上假装支持多线程。
- **不做流式响应**——client 现有 UI 是一次性请求/响应（`{studentMessage, tutorMessage}`），Agent 自己的 `/v1/agent/diagnose` 也是非流式 JSON 响应，两边天然匹配，不引入 SSE/WebSocket。
- **不解决 `LABS_AGENT_BASE_URL` 的 quick tunnel 不稳定问题**——沿用现有运维流程，需要时手动更新 Vercel 环境变量。
- **不新建课程内容摄取/`assessments.json` 相关的功能**——那是数据到货问题，这次只负责"有数据就用，没数据就传空数组"，不阻塞这次集成。
- **不在 client 端渲染 `diagnosis`/`evidence`/`suggested_actions`/`tool_trace` 等结构化字段**——v1 聊天气泡只显示 `answer` 纯文本，完整结构化响应存进 `Conversation.contextRef`，为以后做更丰富的 UI 留门，但这次不做那个 UI。

## 设计原则

- **路由嵌在 `WorkspaceController` 的既有风格下，不新造"thread"抽象**：现有代码里 `console-session`/`console-session/token` 都是 `/workspaces/:enrollmentId/...` 这种嵌套形状。聊天消息本质上也是"这个 workspace/VM 的诊断对话"，语义上属于同一个资源族——用 `/workspaces/:enrollmentId/chat/messages`，不是把 `enrollmentId` 硬套进一个叫"threadId"的 URL 参数里假装有独立的会话线程概念。`Conversation` 表本身的 `threadId` 列保持不动（写入时存 `enrollmentId` 的值），为以后真要拆多线程时留一条自然的迁移路径，而不是现在就要一次破坏性变更。
- **"当前步骤"由 server 自己查，不要求 client 传**：client 只需要在现有 `sendChatMessage`/`chatMessages` 调用里改传 `enrollmentId`（而不是现在的 `course-${courseId}`），server 端 `ChatService` 自己用 `Progress.currentLessonId` 解析出当前 `CourseLesson`，再往上关联 `CourseModule`/`CourseVersion`/`Course` 拼出完整上下文。好处是 client 改动小，且"当前步骤"永远跟 `Progress` 的真实状态一致，不会因为 client 传了过期值而对不上。
- **enrollment 归属校验复用现有约定，不抽公共方法**：`WorkspaceService` 里已经有一个私有的 `requireOwnedEnrollment`（`enrollment.userId !== userId` 时抛 `ForbiddenException('无权访问这个 enrollment')`），但它是 `private`，且目前只有 `WorkspaceService` 自己用，不是导出的公共工具。`ChatService` 这次直接照同样的写法复制一份等价检查（同样的异常类型、同样的错误文案风格），不为了这一次新增就去重构 `WorkspaceService` 抽公共 helper——那是一次不在这次请求范围内的顺手改动。等以后出现第三个需要同样检查的地方，再考虑抽取。
- **VM 没起来就别打 Agent**：`Workspace.status !== RUNNING` 或 `labId` 为空时，直接返回一条固定兜底回复（"请先启动虚拟机"），不发起对 Agent 的 HTTP 调用——省一次注定失败或没有意义的 LLM 调用，用户体验也更直接。
- **结构化响应不能被丢掉**：`DiagnoseResponse` 除了 `answer` 还有 `diagnosis`/`course_alignment`/`evidence`/`suggested_actions`/`limitations`/`tool_trace`，这些字段是 Agent 真实计算出来的诊断证据，即使这轮 UI 用不上，也要存进 `Conversation.contextRef`（这个字段本来就是为这个用途设计的），不是收到就扔。
- **`status: "partial"` 是合法响应，不是错误**：Agent 侧工具调用失败（比如 Diagnostic Gateway 联不上）时，`status` 会标成 `"partial"`，但 HTTP 层面依然是 200，`answer` 字段依然是一段完整、诚实的回复（这次连通性测试已经验证过）。这种情况按正常成功路径处理，只是把 `limitations` 一并存进 `contextRef`；真正的错误处理只针对"HTTP 请求本身失败"（超时、网络错、Agent 未配置、非 2xx）。

## 架构

```
┌──────────────────────┐   ①POST /workspaces/:id/   ┌──────────────────────────┐
│   /workspace 网页       │      chat/messages {text}   │      aivirteach-server     │
│  (Next.js, 已有 JWT)     │────────────────────────────>│      (NestJS, Vercel)      │
│                       │                              │                            │
│                       │                    ChatController → ChatService           │
│                       │                    ② 校验 enrollment 属于当前用户            │
│                       │                    ③ 存一条 USER Conversation               │
│                       │                    ④ 查 Workspace.labId +                  │
│                       │                       Progress.currentLessonId →           │
│                       │                       CourseLesson/Module/Version/          │
│                       │                       LessonAssessment，拼 CourseContext/    │
│                       │                       LessonContext                        │
│                       │                              └─────────────┬──────────────┘
│                       │                                            │ ⑤ AgentClient.diagnose()
│                       │                                            ▼
│                       │                              ┌──────────────────────────┐
│                       │                     POST /v1/agent/diagnose   aivirteach-labs │
│                       │                     Bearer AIVIRTEACH_AGENT_TOKEN  agent-service │
│                       │                              │  DeepSeek + 只读诊断工具集   │
│                       │                              └─────────────┬──────────────┘
│  ⑦渲染 tutorMessage      │<─────────────────────────────────────────┘
│                       │  ⑥存一条 ASSISTANT Conversation
│                       │     content=answer, contextRef=完整 DiagnoseResponse
└──────────────────────┘
```

## 组件设计

### Server：`aivirteach-server`

**`src/chat/chat.module.ts`**：注册 `ChatController`、`ChatService`、`AgentClient`，导入 `PrismaModule`（沿用现有模式）。

**`src/chat/chat.controller.ts`**（挂在 `@UseGuards(JwtAuthGuard)` 下，参考 `WorkspaceController`）：
- `GET /workspaces/:enrollmentId/chat/messages` → `ChatService.getMessages(userId, enrollmentId)`，返回按 `createdAt` 排序的消息列表，形状匹配 client 现有的 `ApiChatMessage[]`。
- `POST /workspaces/:enrollmentId/chat/messages`，body 用 `@Body(new ZodValidationPipe(SendChatMessageSchema))`（**参数级绑定**，不用方法级 `@UsePipes`——这是这次会话早些时候在 `exchangeConsoleToken` 上真实踩过、修过的坑，这里直接按修复后的写法来，不重蹈覆辙）→ `ChatService.sendMessage(userId, enrollmentId, text)`，返回 `{studentMessage, tutorMessage}`。

**`src/chat/chat.service.ts`**：
- `getMessages`：确认 `enrollment.userId === userId`（否则抛 `ForbiddenException('无权访问这个 enrollment')`，跟 `WorkspaceService` 里 `requireOwnedEnrollment` 的既有写法一致），查 `Conversation` 表。
- `sendMessage`：按"设计原则"里描述的步骤①-⑦执行；VM 未就绪、Agent 未配置、Agent 调用失败这三种情况都落在"持久化一条兜底 ASSISTANT 消息 + 正常返回"这条路径上，不让 HTTP 层抛 500——聊天场景下，把错误当成一条对话回复处理，比让整个请求失败更符合 client 现有的 UI 预期。
- 内部拆出 `buildDiagnoseContext(enrollment)` 之类的小函数专门负责查 `Progress`/`CourseLesson`/`LessonAssessment` 并组装 `CourseContext`/`LessonContext`，不要全塞进一个大方法里（对应 coding-style 的"函数 <50 行"）。两个字段的形状跟 Prisma 不直接对应，需要显式转换：
  - `LessonContext.instructions`（`list[str]`）没有直接对应的 Prisma 字段，从 `CourseLesson.activityPrompt` 按换行拆分成多条（`activityPrompt.split(/\n+/).filter(Boolean)`）；没有换行就是单元素列表。
  - `LessonContext.common_failures`（`list[{code, symptoms}]`）跟 `LessonAssessment.commonFailures: String[]` 不是同一形状，需要把每条字符串包成 `{ code: <该字符串>, symptoms: [] }` 再传，不能原样透传数组。

**`src/chat/agent-client.ts`**（仿照 `src/workspace/labs-client.ts` 的写法）：
- 读 `LABS_AGENT_BASE_URL`（新增到 `src/config/env.ts`，`z.url().optional()`，注释沿用现有 Labs 变量"缺配置不让整个 server 起不来"的约定）+ 复用 `AIVIRTEACH_AGENT_TOKEN`（同样标 `optional()`）。
- `diagnose(payload)`：`POST ${LABS_AGENT_BASE_URL}/v1/agent/diagnose`，`Authorization: Bearer ${AIVIRTEACH_AGENT_TOKEN}`，显式超时（参考这次连通性测试的真实耗时，定一个比如 60s 的上限，超时按错误处理，不无限等）。缺配置时抛 `ServiceUnavailableException`，模式与 `LabsClient.createVm` 完全一致。

**`prisma/schema.prisma`**：`Conversation` 表结构已存在，不需要新迁移；只需要确认 `content`/`contextRef` 的实际写入方式符合"content 存 answer 纯文本，contextRef 存完整 DiagnoseResponse JSON"这条约定。

**`src/config/env.ts`**：新增 `LABS_AGENT_BASE_URL: z.url().optional()`；`AIVIRTEACH_AGENT_TOKEN` 同样新增为 optional 字符串。

### Client：`aivirteach-client`

- `app/lib/api.ts`：`chatMessages`/`sendChatMessage` 的 URL 从 `/chat/threads/:threadId/messages` 改成 `/workspaces/:enrollmentId/chat/messages`（方法签名的参数名从 `threadId` 改成 `enrollmentId`，语义更准确）。
- `app/workspace/page.tsx` 有三处调用点都要改，不只是 `sendMessage`/`refreshTutor`：
  - `sendMessage`（约 268 行）、`refreshTutor`（约 334 行）里构造的 `` `course-${course?.id ?? "learning-lab"}` `` 改成 `enrollment.id`（`enrollment` 已经是页面现有的状态变量，不需要额外请求）。
  - 挂载时加载历史消息的 `useEffect`（约 162-166 行，现状是硬编码 `api.chatMessages("learning-lab")`、依赖数组是 `[]`）也要改：依赖数组换成 `[enrollment]`，并在 `enrollment` 还没加载出来时直接 `return`（不发请求）——否则会在页面刚挂载、`enrollment` 还是 `null` 的那一刻，用一个不存在的 enrollmentId 打一次注定 403 的请求。
- 其余聊天 UI（消息列表渲染、输入框、`initialMessages` 兜底）不需要改，因为响应形状 `{studentMessage, tutorMessage}` 保持不变。

### Labs：`aivirteach-labs`

- 无需改动。`agent-service` 已经是完整实现，这次实测确认可用。唯一需要的是运维侧动作：确认 `LABS_AGENT_BASE_URL` 指向的 quick tunnel 在联调/上线时是最新的（跟现有 `LABS_VM_BASE_URL` 一样的手动同步流程）。

## 数据流（发一条消息的完整时序）

1. 学员在聊天框输入问题，点击发送 → client `POST /workspaces/:enrollmentId/chat/messages {text}`。
2. `ChatController` 走 `JwtAuthGuard` + `ZodValidationPipe`（参数级绑定在 `@Body()` 上）。
3. `ChatService.sendMessage`：确认 enrollment 属于当前用户（不属于则 403） → 落一条 `USER` `Conversation` 行。
4. 查 `Workspace`（可能为 `null`，enrollment 还没建过工作区）：不存在 / `labId` 为空 / `status !== RUNNING` → 落一条固定兜底 `ASSISTANT` 行（"请先启动虚拟机"）→ 直接返回，不调用 Agent。
5. 否则：查 `Progress.currentLessonId → CourseLesson → CourseModule → CourseVersion → Course`，以及对应 `LessonAssessment`（可能为空），拼出 `CourseContext`/`LessonContext`。
6. `AgentClient.diagnose()` 调 Labs 的 `POST /v1/agent/diagnose`。
7. 成功（含 `status: "partial"`）：落一条 `ASSISTANT` 行，`content = response.answer`，`contextRef = JSON.stringify(response)`。
8. 失败（超时/网络错/Agent 未配置/非 2xx）：落一条兜底 `ASSISTANT` 行（"助教暂时不可用，请稍后再试"一类文案），详细错误只记 server 端日志（不回给 client，避免泄露内部服务地址/栈信息）。
9. 返回 `{studentMessage, tutorMessage}`，client 渲染成聊天气泡。

## 错误处理

| 情况 | 处理方式 |
| --- | --- |
| enrollment 不属于当前用户 | `ForbiddenException`（403，与 `WorkspaceService.requireOwnedEnrollment` 一致） |
| 请求体校验失败（`text` 为空等） | `ZodValidationPipe` 400，沿用现有错误格式 |
| Workspace 不存在 / `labId` 为空 / `status !== RUNNING` | 不报错，落一条固定兜底 `ASSISTANT` 消息，200 返回 |
| `LABS_AGENT_BASE_URL`/`AIVIRTEACH_AGENT_TOKEN` 未配置 | `AgentClient` 抛 `ServiceUnavailableException`，`ChatService` 捕获后落兜底消息，200 返回 |
| Agent 调用超时 / 网络错误 / 非 2xx | 同上，捕获后落兜底消息，200 返回；完整错误详情记 server 日志 |
| Agent 返回 `status: "partial"` | 正常成功路径，不特殊处理，`limitations` 存进 `contextRef` |

*为什么失败路径也返回 200 而不是 5xx*：client 现有 UI 把每次 `sendChatMessage` 都当成"一定会拿到一条 tutor 回复"来渲染（参考现有 catch 块逻辑），把服务端故障也建模成一条对话消息，比让 client 处理一个独立的错误状态更符合已有交互设计，也不需要改 client 的错误处理逻辑。

## 测试

- **`agent-client.spec.ts`**：完全比照 `labs-client.spec.ts` 的现成模式（`Test.createTestingModule` 手动 DI + mock `global.fetch`，不引入额外 mock 库）。覆盖：缺配置抛 `ServiceUnavailableException`、成功解析响应、超时/非 2xx 抛出可辨识的错误。
- **`chat.service.spec.ts`**：mock `AgentClient` + Prisma，覆盖：越权访问、VM 未就绪的兜底路径、Agent 调用成功（含 `partial` 状态）、Agent 调用失败的兜底路径、`contextRef` 确实存了完整响应。
- **e2e 测试**（真正启动 `INestApplication`，不是只用 `Test.createTestingModule` 拿 controller 实例直接调方法）：至少一条覆盖 `POST /workspaces/:enrollmentId/chat/messages` 完整请求-响应链路，确认 `JwtAuthGuard`/`ZodValidationPipe` 真的生效——这条是这次会话踩过 `exchangeConsoleToken` 方法级 `@UsePipes` 那个坑之后特意加的，避免同一类"单元测试掩盖 guard/pipe 未生效"的问题再次发生。

## 部署清单更新

- Vercel `LABS_AGENT_BASE_URL`（新增，Sensitive 类型，跟 `LABS_VM_BASE_URL` 一样）+ `AIVIRTEACH_AGENT_TOKEN`（新增，值取自 Labs 主机 `agent-service/config/agent.env` 里的同名变量）。
- 联调前确认同事那边 `agent-service`（8770）的 quick tunnel 是最新的——这次连通性测试用的地址会过期，正式联调需要一份新地址。
- 不需要新的 Cloudflare Access Application（`AgentClient` 走的是 server-to-Agent 的 Bearer token，不是浏览器直连，跟 `LABS_VM_BASE_URL` 同一套信任模型）。
