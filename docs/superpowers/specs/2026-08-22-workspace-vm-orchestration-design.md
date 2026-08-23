# Workspace VM 编排设计：Client 启动 VM，Server 中转 Labs

## 背景

架构文档（`2026-08-11-aivirteach-technical-architecture.html`）里的"三者联动"分四条数据流，之前完成的
`docs/superpowers/plans/2026-08-20-course-catalog-and-learning-api.md` 只覆盖了流①（client↔server↔Postgres，
Labs 完全不参与）。这次做流②的前半段：**client 请求启动 VM → server 中转调用 Labs → 状态推回 client**，
不含 VM 起来之后 client 直连 Labs 的那部分（Console/Guacamole，见"不做的事"）。

现状核对：

- `aivirteach-server` 目前没有任何 workspace 相关代码（`find src -iname "*workspace*"` 为空），也没有任何
  WebSocket 基建（没装 `@nestjs/websockets`）。
- `aivirteach-client` 的 `app/workspace/page.tsx` 目前不调用任何创建 VM 的接口，只是读一个构建时写死的环境变量
  `NEXT_PUBLIC_LEARNING_VM_URL` 塞进 `<iframe>`，没有就显示"Awaiting connection"占位。
- Prisma schema 里 `Workspace` 表（`labId`、`ip`、`rdpPort`、`rdpUsername`、`vncPort`、
  `status: WorkspaceStatus`）在更早的 schema 设计阶段已经按 Labs 真实接口建好，这次直接用，不用改表。

## 关键事实核对

- **`POST /v1/vms` 是同步阻塞调用**：Labs 的 `service.py` 直接 `await` 执行
  `create-learner-vm.sh`，最长等 `CREATE_TIMEOUT_SECONDS=180` 秒才返回结果（成功给凭证，失败给错误）。
  不是"先返回、之后再轮询"的异步模型——一次 HTTP 调用本身就是那个"等待"。
- **Labs 没有任何主动推送能力**：`aivirteach-labs` 仓库里没有一处 WebSocket 代码（无
  `@app.websocket`、无 websockets 依赖），只有同步 REST。server 不可能等 Labs 推送状态回来，只能自己发起调用
  并处理这次调用的结果。
- **Redis 本地已经在跑，但生产落地方式未定**：`docker-compose.yml` 里已有 `aivirteach-redis` 容器
  （56379 端口），但 `package.json` 没有 `bullmq`/`ioredis`，`.env.example` 没有 `REDIS_URL`。即使本地起
  BullMQ 门槛很低，生产环境（server 部署在 Vercel serverless 上）该由谁跑 BullMQ 常驻 worker 仍然没有答案——
  这是一个独立的生产部署决定，这次不做，选择更简单的方案（见"设计原则"）。
- **`aivirteach-server` 部署在 Vercel serverless 上**：函数默认不适合裸等 3 分钟；用
  `@vercel/functions` 的 `waitUntil()` 可以在响应之后继续跑后台逻辑，但函数实例如果被 Vercel 回收，未跑完的
  `waitUntil` 任务会丢失——这是选简单方案要接受的代价，已经在"错误处理"里给出缓解方式。
- **Labs 侧文档明确把 `service.py` 定性为原型**（`libvirt/README.md` 第 9 节）："These scripts are for a
  manual prototype... Do not let the public FastAPI process execute arbitrary shell input."
  这不是这次要解决的问题，但佐证了把 Labs 暴露到公网时在 Cloudflare 边缘加一层 Access 认证的必要性
  （见"部署清单"）。

## 不做的事（明确排除的范围）

- **VM 起来之后 client 怎么直连 Labs 看画面**：架构文档里 Console 那条旁路，`libvirt/README.md` 写明目标方案
  是 `Learner browser → Guacamole/RDP → learner VM:3389`（Apache Guacamole，不是 noVNC），但 Guacamole 在
  Labs 仓库里完全没有部署（zero 配置文件）。这是一个独立规模的基础设施项目（部署 `guacd`、接入 Labs 私有
  libvirt 网络、设计 ticket 换 Guacamole 临时连接令牌、新开一条 Cloudflare Tunnel hostname），单独立项设计，
  不在这次 spec 里。`Workspace` 表已经预留了 `ip`/`vncPort`/`labId` 字段，未来做这部分不需要因为这次的设计
  返工。
- **VM 的 stop/reboot/delete 等动作**：这次只做"开机"（create），其余 `VMAction`（start/stop/force-stop/
  reboot）走类似模式，等前半段跑通后再加，不在这次范围。
- **BullMQ 真队列**：本地 Redis 有了，但生产 worker 托管方式未定，先用进程内 `waitUntil`，见上。

## 设计原则

1. **Server 是 Labs 唯一合法调用方，Labs 现有接口原样使用**，不改 Labs 一行代码。
2. **简单优先**：进程内异步 + `waitUntil`，不引入 BullMQ/Redis 依赖——生产 worker 托管方式是独立决定，
   等真的需要（比如要支持大量并发创建、需要重试/限流）时再单独评估。
3. **创建时机**：client 落地 `/workspace` 页、发现没有已存在的 workspace 时才建，不在报名（enroll）那一刻
   预建，避免占用 VM 资源。
4. **Server → Client 用 WebSocket 推送状态**，不是 client 轮询 server；Server → Labs 内部是一次同步调用，
   不是轮询 Labs 的 status 接口。
5. **数据库唯一约束防重复创建**：`Workspace.enrollmentId` 已经是 `@unique`，天然防止双开标签页/重复点击
   产生两条 workspace 记录。

## 架构

```
Client (/workspace 页)
   │  GET /workspaces/:enrollmentId   查当前状态，没有则 404
   │  POST /workspaces                没有就创建
   │  WS 订阅 workspace 状态推送
   ▼
Server（NestJS，新增 WorkspaceModule）
   │  POST /v1/vms（同步调用，最长等 180s，用 waitUntil 后台跑）
   ▼
Labs service.py（不改代码，原样用）
   ── Cloudflare Tunnel + Access Service Token（部署工作，见"部署清单"）──
```

## 组件设计

### Server：新增 `src/workspace/`

- **`WorkspaceController`**
  - `GET /workspaces/:enrollmentId` — 校验调用者拥有这个 enrollment；没有对应 Workspace 记录返回 404。
  - `POST /workspaces` — body `{ enrollmentId }`；校验 enrollment 属于调用者且是 active 的；创建
    `Workspace` 行（`status=CREATING`）；立刻返回 202 + 这行数据；触发后台创建逻辑（见下）。
- **`WorkspaceService`**
  - 编排逻辑：建行 → `waitUntil(createVmInBackground(workspace))` → 成功/失败都更新数据库行并通过
    `WorkspaceGateway` 广播。
  - 幂等：如果 `enrollmentId` 已有 `Workspace` 行且状态是 `ERROR`，`POST /workspaces` 视为"重试"，复用
    该行重新走一次创建，不插入新行。
- **`LabsClient`**（新，小型 HTTP 客户端封装）
  - 包一层 `fetch`，统一加上 Cloudflare Access Service Token 请求头（`CF-Access-Client-Id` /
    `CF-Access-Client-Secret`）和现有的 `AIVIRTEACH_API_TOKEN` bearer。
  - 超时设置要覆盖 Labs 的 `CREATE_TIMEOUT_SECONDS=180`，建议 200s 留余量。
  - 只暴露这次需要的一个方法：`createVm(labId, opts)`，对应 `POST /v1/vms`。
- **`WorkspaceGateway`**（新，`@nestjs/websockets`）
  - Server 目前零 WebSocket 基础设施，这是本次唯一的新基建依赖。
  - Client 连接后按 `enrollmentId` 订阅一个房间/频道（不用 `workspaceId`——client 在 workspace
    创建出来之前不知道它的 id，`enrollmentId` 从一开始就有）；`WorkspaceService` 更新状态时往对应频道 emit
    一个 `workspace.status` 事件，payload 是最新的 Workspace 行。
  - 鉴权：复用现有 JWT 校验逻辑，握手阶段校验 token，拒绝未认证连接。

### Client：`aivirteach-client`

- `app/lib/api.ts` 新增 `api.workspace(enrollmentId)`（GET，可能 404）和
  `api.createWorkspace(enrollmentId)`（POST）。
- 新增一个轻量 WebSocket 客户端封装（连接、鉴权、订阅频道、暴露状态回调）。
- `app/workspace/page.tsx`：在现有的课程加载 `useEffect` 之后，加一段——GET workspace，没有就 POST 创建，
  然后连 WS 等状态变化；`CREATING` 时显示"准备中"状态，`ERROR` 时显示失败信息 + 重试按钮，`RUNNING` 时维持
  现有的 iframe/`vmUrl` 占位逻辑不变（因为真实连接地址属于 Guacamole 那部分，这次不做）。

## 数据流（创建 VM 的完整时序）

```
1. Client 落地 /workspace，已有 active enrollment
2. Client → GET /workspaces/:enrollmentId
     存在且非 CREATING → 直接渲染，跳过后面步骤
     404（没有）        → 走 3
     存在且 CREATING    → 走 5（说明上次没等完，续等）
3. Client → POST /workspaces { enrollmentId }
4. Server：
     - 校验 enrollment 属于当前用户 + 是 active 的
     - 建 Workspace 行（status=CREATING），DB 对 enrollmentId 有唯一约束，天然防重复创建
     - 立刻 202 返回这行数据
     - waitUntil() 里继续：调 Labs POST /v1/vms（lab_id 用 workspace.id）
         成功 → 更新行（status=RUNNING, ip/rdpPort/vncPort/labId）→ WS 推送
         失败/超时 → 更新行（status=ERROR, errorMessage）→ WS 推送
5. Client 连 WebSocket，订阅这个 workspaceId，等 status 变化事件
     RUNNING → 显示 VM 区域（iframe 占位，跟现在一样）
     ERROR   → 显示失败信息 + 重试按钮
```

## 错误处理

- **Labs 调用失败/超时**：Workspace 记 `ERROR` + `errorMessage`，WS 推给 client，client 给重试按钮，重试
  就是再发一次 `POST /workspaces`（走幂等逻辑，复用已有行）。
- **函数实例中途被 Vercel 回收，`waitUntil` 没跑完就没了**：这是选简单方案必须接受的代价——Workspace 会
  卡在 `CREATING`，没人再更新它。缓解：`GET /workspaces/:id` 里判断——如果 `status=CREATING` 且
  `createdAt` 超过 5 分钟（比 Labs 自己 180 秒超时留足余量），当作过期失败处理，允许 client 重新触发创建。
- **双开标签页同时触发创建**：DB 唯一约束顶住，第二次 `POST` 命中已有行，走幂等逻辑而不是报错或插入新行。

## 测试

- `WorkspaceService` 单测：mock `LabsClient`，覆盖成功、超时/报错、对同一 `enrollmentId` 重复创建三种情况。
- `POST /workspaces` 集成测试：断言 202 + 返回行是 `CREATING`；测试环境里直接 `await` 那段后台逻辑（不依赖
  真实 Vercel `waitUntil` 运行时行为），断言最终 DB 状态和 WS 广播都对。
- `WorkspaceGateway` 测试：client 连上、订阅、收到推送事件。
- **无法覆盖的部分**：真实连到 Labs 私网主机这段没法在 CI/本地跑通，起一个本地 stub 服务模拟
  `POST /v1/vms` 的行为来测；真实环境验证要等 Cloudflare Tunnel 部署好之后手动过一遍。

## 部署清单（给负责 Cloudflare Tunnel 的同事）

这一节写于实现之前，只记录目标形状。`LabsClient` 落地后实际只调用了 VM Manager（`POST /v1/vms`），
没有用到 Agent 相关接口，`LABS_AGENT_BASE_URL` 也没有出现在 server 代码里。以当前代码为准的详细清单见
[`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md)，这里不再重复维护。
