# Console/RDP 远程桌面接入设计：改接 Guacamole，替换 IronRDP + websockify

## 背景

[Console/RDP 接入设计（IronRDP + websockify 版）](./2026-08-23-console-rdp-access-design.md) 已经按计划实现，`aivirteach-server` PR #9、`aivirteach-client` PR #3 都已经落地对应代码并进入 review 阶段。

**这是对那份设计的替代，不是补充。** 同事在 `aivirteach-labs` 上另起了一个 `vm_agent_local` 分支，把 Labs 主机的桌面接入方案换成了 Apache Guacamole（`guacd` + `guacamole` webapp，Docker Compose 部署），并已经把这个分支部署到了 Labs 主机（通过 Cloudflare Quick Tunnel 临时验证）。核对代码后确认：`vm_agent_local` 的 `service.py` 里根本没有 `POST /v1/vms/{lab_id}/console-token` 这个接口（IronRDP 版设计里 `websockify` token 登记用的那个），取而代之的是一个铸造 Guacamole 加密票据的 `POST /v1/vms/{lab_id}/browser-sessions`。也就是说 Labs 侧的实现路径已经变了，`aivirteach-server`/`aivirteach-client` 现有代码接不上去。

跟用户确认过两个关键范围决策：
1. 不引入 Tauri 桌面壳——`aivirteach-client` 上确实还有同事另起的 `vm_vlient` 分支（2 个 commit 的 Rust/Tauri 早期实验，未接入正式代码，`docs/desktop-app.md` 也不存在），但这次明确只在现有 Next.js 浏览器客户端里做，不跟进 Tauri 方向。
2. 浏览器端用 `guacamole-common-js` 自己接 Guacamole 的 WebSocket tunnel，渲染到我们自己的容器里，不用 iframe 嵌 Guacamole 官方 Web UI。

**订正（brainstorming 阶段的一个事实性错误）**：讨论过程中一度以为 `src/workspace/workspace.gateway.ts`（`WorkspaceGateway`）是给 websockify/RDP 流量转发用的 NestJS WebSocket 网关，并决定连同它的 IDOR 修复一起整个删除。重新读代码后确认这是错的——`WorkspaceGateway` 是 PR #8（workspace VM 编排）引入的**工作区创建状态推送通道**（`/api/v1/workspaces/socket`，推送 `{type: "workspace.status", workspace}`，客户端 `app/lib/ws.ts` 消费），只用来通知前端 VM 从 `CREATING` 变成 `RUNNING`/`ERROR`，从来没有经手过任何 RDP/console 流量——即使在 IronRDP 版设计里，浏览器也是直接连 `websockify`，不经过这个网关。这份设计**不改动 `WorkspaceGateway`**，之前修的 IDOR 保持原样。

**不改动 `aivirteach-labs` 仓库**——`vm_agent_local` 是同事的工作，这份设计只覆盖 `aivirteach-server`、`aivirteach-client` 如何对接它已经暴露出来的 Guacamole 接口。

## 关键事实核对

- `vm_agent_local` 的 `POST /v1/vms/{lab_id}/browser-sessions`（跟现有 `POST /v1/vms`、`GET /v1/vms/{lab_id}/credentials` 同一个 FastAPI app，同一个 8760 端口/`labs-vm.<domain>` 主机）：
  - 鉴权用 `Authorization: Bearer <AIVIRTEACH_SESSION_TOKEN>`——一个新的静态密钥，Labs 服务端会校验它跟 `AIVIRTEACH_API_TOKEN` 不能相同。
  - 请求体 `{"subject": "<1-160 字符，仅允许字母数字 . _ @ ->"}`。
  - 响应 `{lab_id, state, data?, expires_at?}`：`state` 取值 `"starting"`（VM 关机中，Labs 已经顺手发了启动命令）、`"unavailable"`（其它非运行状态）、`"ready"`（VM 在跑、RDP 端口已探测可连），或者原始 libvirt 状态字符串。只有 `state === "ready"` 时才有 `data`/`expires_at`。
  - `data` 是 Guacamole [JSON 认证扩展](https://guacamole.apache.org/doc/gug/json-auth.html) 格式的加密票据（HMAC-SHA256 签名 + AES-128-CBC 加密，用同一把 `GUACAMOLE_JSON_SECRET`）：内含 `{username: subject, expires, connections: {<lab_id>: {protocol: "rdp", parameters: {hostname, port, username, password, ...}}}}`。**RDP 密码是 Labs 服务端直接现取现塞进这个加密票据里的，`aivirteach-server` 全程不会再经手明文 RDP 密码**——这比 IronRDP 版设计（server 要单独调 `GET .../credentials` 拿明文密码再透传给浏览器）安全性更好，是这次改动顺带的收益，不是刻意设计的目标。
  - 这个 `data` 票据本身不能直接用来连 RDP，必须先 POST 给 Guacamole 自己的 `/api/tokens` 换成真正的 Guacamole `authToken`，浏览器/`guacamole-common-js` 才能拿 `authToken` 开 WebSocket tunnel。
- `browser-sessions` 走的是**跟现有 VM 生命周期 API 相同的主机和 Cloudflare Access 保护**（`labs-vm.<domain>`，`CF-Access-Client-Id`/`CF-Access-Client-Secret`）——这次不需要为它新增任何 Cloudflare 配置，只是同一个 Access Application 下多一条路由。
- 真正的 Guacamole WebSocket tunnel（浏览器直连，走 `labs-console.<domain>`，不挂 Access——原因跟 IronRDP 版设计里 `labs-console` 不挂 Access 一致：浏览器没法持有 Service Token，身份验证已经在 `/workspace` 页面的 JWT 会话完成，这次换成 Guacamole 票据本身的加密+过期做保护）现在指向的是 Labs 主机上 Guacamole webapp 的端口（Docker Compose 里是 `8080`），不再是 `websockify` 的 `6080`。
- `guacamole-common-js`（npm 上的 [`guacamole-common-js`](https://www.npmjs.com/package/guacamole-common-js) 包，[padarom/guacamole-common-js](https://github.com/padarom/guacamole-common-js) 维护）是 Apache Guacamole 官方浏览器客户端源码的第三方 npm 打包——Apache Guacamole 项目本身不发布 npm 包，这是社区通用的引入方式，最新版 `1.5.0`（发布于 2023-03）。提供 `Guacamole.Client`（`connect(data?: any)`/`getDisplay()`/`disconnect()`/`sendMouseState()`/`sendKeyEvent()` 等）+ `Guacamole.WebSocketTunnel`（构造函数 `new WebSocketTunnel(tunnelURL: string)`），渲染到调用方提供的 DOM 元素、通过 `client.getDisplay().getElement()` 拿到画面节点，鼠标/键盘转发用 `Guacamole.Mouse`/`Guacamole.Keyboard` 两个配套类（用法已核实，见实现计划）。**有官方 TypeScript 类型定义**：`@types/guacamole-common-js`（DefinitelyTyped 维护，当前版本 `1.5.5`），不需要手写 `.d.ts`。这次唯一没有先例验证过的集成点是：npm 包最新只到 `1.5.0`，而 Labs 的 Docker Compose 部署的是 `guacd`/`guacamole` `1.6.0`——1.5.0 版本的 JS 客户端库能不能正常连 1.6.0 版本的服务端，需要一个 spike 任务实测确认（见"测试"一节），不能假设次版本号不同就必然兼容。
- `aivirteach-server` 现有 `LabsClient.getCredentials()`/`registerConsoleToken()` 只被 `createConsoleSession` 一处调用（已用 `grep` 核实），删除它们不影响任何其它路径。

## 不做的事（明确排除的范围）

- **不碰 `aivirteach-labs` 仓库**——Guacamole 的部署、`browser-sessions` 接口本身、Docker Compose 配置都是同事在 `vm_agent_local` 分支上的工作，这份设计不涉及改它。
- **不引入 Tauri**——`vm_vlient` 分支是另一件未完成的事，不在这轮范围内跟进。
- **不用 iframe 嵌 Guacamole 官方 Web UI**——用 `guacamole-common-js` 自己接。
- **不改动 `WorkspaceGateway`**——它是工作区创建状态推送通道，跟 RDP/console 传输无关，见上面"背景"一节的订正；保留原样，不删、不改、不迁移逻辑。
- **不做服务端阻塞等待 VM 就绪**——`console-session` 接口每次被调用只转发 Labs 当前返回的 `state`，不在服务端内部轮询，由客户端负责重复请求。
- **不新增 Prisma model**——`browser-sessions` 的票据（`data`/`expiresAt`）不落库，每次现取现转发，延续 IronRDP 版设计"单次请求内一次性生成一次性使用"的原则。
- **不重新设计 Cloudflare Tunnel/Access 的整体拓扑**——沿用 IronRDP 版设计已经定下的"`labs-vm` 挂 Access，`labs-console` 不挂 Access"的模型，只是 `labs-console` 现在转发到 Guacamole 而不是 `websockify`。是否要改成同事文档里提到的"同源 path 反代"，这次不采纳（`aivirteach-client` 部署在 Vercel，Next.js 的 `rewrites()` 对外部目标不可靠地支持 WebSocket upgrade 转发，继续用独立 Cloudflare Tunnel hostname 更稳妥，也更贴近现有部署文档的经验）。

## 设计原则

- **RDP 密码全程不经过 `aivirteach-server`**：Labs 直接把密码加密进 Guacamole 票据，我们的服务端只是转发这个不透明的 `data` 字符串，不解密、不查看、不落库、不记日志。
- **票据加密签名本身就是安全边界**：enrollment 归属校验在已有 JWT 鉴权保护的 REST 端点（`POST /workspaces/:enrollmentId/console-session`，沿用 `requireOwnedEnrollment`）里做一次；票据本身的防伪造/防篡改/防重放（签名 + 过期时间）由 Guacamole 协议保证，浏览器拿到票据之后直连 Guacamole，不再经过我们的服务端——这条路径本来就不经过 `WorkspaceGateway`，这次改动前后一致。
- **轮询责任在客户端，不在服务端**：VM 从关机到 RDP 就绪可能要几十秒到几分钟，服务端每次调用只做一次转发，不阻塞等待——这样不占用 serverless 函数的执行时间，也能让页面展示"VM 启动中"这类中间状态，而不是一直转圈直到超时才有反馈。
- **复用现有 enrollment 归属校验模式**：沿用 `workspace.service.ts` 里已经有的 `requireOwnedEnrollment` 写法，不新造一套校验逻辑。

## 架构

**阶段一：学员点击按钮，服务端转发票据请求**

```
┌────────────────────┐  ①POST /workspaces/:id/  ┌──────────────────────────┐
│    /workspace 网页    │     console-session      │      aivirteach-server     │
│  (Next.js，已有 JWT    │─────────────────────────>│      (NestJS, Vercel)      │
│   会话)               │                          │  校验 owner (JwtAuthGuard  │
│                     │                          │  + requireOwnedEnrollment)│
│                     │                          └─────────────┬─────────────┘
│                     │                                        │
│                     │                       ②POST /v1/vms/{id}/browser-sessions
│                     │                         {subject: user.id}
│                     │                         Bearer AIVIRTEACH_SESSION_TOKEN
│                     │                         + CF-Access 头
│                     │                                        ▼
│                     │                          ┌──────────────────────────┐
│  ③拿到                │<─────────────────────────│   Labs VM Manager (8760)   │
│  {state, data?,      │  {state, data?,          │   (vm_agent_local，同事)    │
│   expiresAt?}        │   expires_at?}           └──────────────────────────┘
└──────────┬──────────┘
           │ state !== "ready" ? 2-3 秒后回到 ① 重新请求（最多轮询 ~2 分钟）
           │ state === "ready" ? 进入阶段二
```

**阶段二：浏览器直接建立 Guacamole 会话**

```
┌──────────────────────┐  ④POST data 换 authToken  ┌──────────────────────┐
│  guacamole-common-js   │  https://labs-console.    │   Guacamole webapp     │
│  组件，嵌在 /workspace   │  <domain>/api/tokens      │   (Labs 主机，无 CF     │
│  页面里                 │───────────────────────────>│   Access，同事部署)     │
│                       │<───────────────────────────│                       │
│  ⑤用 authToken 开        │  {authToken, ...}          └──────────┬────────────┘
│  WebSocket tunnel       │                                        │
│  wss://labs-console.    │────────────────────────────────────────>│ ⑥转发到 guacd
│  <domain>/websocket-    │                                        ▼
│  tunnel?token=...       │                              ┌──────────────────┐
│                       │<───────────────────────────────│  guacd → VM:3389   │
│  ⑦渲染桌面, 键鼠/         │        RDP 数据 (Guacamole 协议)  │  (xrdp)            │
│  剪贴板转发               │                                  └──────────────────┘
└──────────────────────┘
```

## 组件设计

### Server：`aivirteach-server`（`docs/console-rdp-access-spec` 分支，原地改）

**不动**：`src/workspace/workspace.gateway.ts`、`WorkspaceModule` 里对它的注册——工作区状态推送，跟这次改动无关。

**`src/workspace/labs-client.ts`**：删除 `getCredentials()`、`registerConsoleToken()`，新增：

```typescript
export type BrowserSession = {
  labId: string;
  state: string;
  data?: string;
  expiresAt?: string; // ISO 时间戳，由 Labs 返回的 epoch ms（expires_at）转换而来
};

async createBrowserSession(labId: string, subject: string): Promise<BrowserSession> {
  // 同 createVm：缺配置抛 ServiceUnavailableException，非 2xx 抛格式化 Error
  // POST `${LABS_VM_BASE_URL}/v1/vms/${labId}/browser-sessions`
  // body: { subject }
  // headers: Authorization: Bearer ${AIVIRTEACH_SESSION_TOKEN} + 现有 CF-Access 头（跟其它方法一致）
  // 响应里的 expires_at（epoch ms）转成 ISO 字符串放进 expiresAt，data/state 原样透传
}
```

**`src/workspace/workspace.service.ts`**：`createConsoleSession` 改为——校验 owner + `workspace.status === RUNNING`（这条前置校验不变）之后，直接调 `labsClient.createBrowserSession(workspace.labId!, user.id)` 并把结果原样返回，不再拼 `wsUrl`、不再单独取密码。

**`src/workspace/workspace.controller.ts`**：`POST /workspaces/:enrollmentId/console-session` 路由不变（沿用现有 `JwtAuthGuard` + owner 校验），返回类型改为：

```typescript
type ConsoleSessionResponse = {
  labId: string;
  state: string; // "starting" | "unavailable" | "ready" | 其它 libvirt 状态
  data?: string; // 只有 state === "ready" 时存在，透传给客户端的 Guacamole 加密票据
  expiresAt?: string;
  guacamoleBaseUrl?: string; // 只有 state === "ready" 时存在，来自 env.LABS_GUACAMOLE_BASE_URL
};
```

**`src/config/env.ts`**：
- 新增 `AIVIRTEACH_SESSION_TOKEN`（可选字符串，延续 `LABS_VM_BASE_URL`/`AIVIRTEACH_API_TOKEN` 现有的"本地/CI 不配也能跑，真正调用 Labs 时才报错"约定，不在 schema 层面强制必填）——跟 `AIVIRTEACH_API_TOKEN` 语义上是两个不同密钥，在 `LabsClient.createBrowserSession()` 里加一条校验确保两者配置了且不相同，Labs 服务端已经有这条校验，服务端这边对称加一条能更早发现配错）。
- `LABS_CONSOLE_WS_URL` 重命名为 `LABS_GUACAMOLE_BASE_URL`（值形如 `https://labs-console.<domain>/guacamole/`，指向 Guacamole webapp 的根路径；客户端从这个值派生出 `api/tokens` 和 `websocket-tunnel` 两个具体地址，不在服务端拼死）。
- 不变：`LABS_VM_BASE_URL`、`AIVIRTEACH_API_TOKEN`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`。

### Client：`aivirteach-client`（`feat/workspace-vm-orchestration` 分支，原地改）

- **`app/workspace/console-viewer.tsx`**：整个重写，改用 `guacamole-common-js`：
  - props 改为 `data`、`expiresAt`、`guacamoleBaseUrl`（对应服务端新响应结构）。
  - 内部：先 `fetch(\`${guacamoleBaseUrl}api/tokens\`, { method: "POST", body: new URLSearchParams({ data }) })` 换 `authToken`；再把 `guacamoleBaseUrl` 的 scheme 从 `https:` 换成 `wss:`（`http:` 换成 `ws:`，只是为了支持本地非 TLS 调试）得到 tunnel 用的 base，`new Guacamole.WebSocketTunnel(\`${wsBase}websocket-tunnel\`)` + `new Guacamole.Client(tunnel)` 建立连接（连接参数里带 `authToken` + `GUAC_DATA_SOURCE=json` + 连接标识，具体参数名以 `guacamole-common-js` 实际版本文档/spike 结果为准，不在设计阶段写死）；把 `client.getDisplay().getElement()` 挂到组件内部容器 DOM 节点；用 `Guacamole.Mouse`/`Guacamole.Keyboard` 转发键鼠事件——这部分直接替换掉原来接 `ironrdp-web` 的等价逻辑，组件对外暴露的 `onConnect`/`onError`/`onDisconnect` 回调接口保持不变，`app/workspace/page.tsx` 侧基本不用改。
  - 依赖：新增 npm 包 `guacamole-common-js` + `@types/guacamole-common-js`（DefinitelyTyped 官方类型，不需要手写 `.d.ts`）。
- **`app/workspace/page.tsx`**：新增轮询逻辑——调用 `console-session` 后，`state !== "ready"` 时每 2-3 秒重新调用，超过 2 分钟未 ready 则展示明确的超时错误（不再继续轮询）；`state === "ready"` 时才渲染 `console-viewer` 组件。原有"workspace 状态离开 RUNNING 时清空 consoleSession/consoleError"的 `useEffect` 逻辑保留，字段名跟着新响应结构调整。

## 数据流（创建连接的完整时序）

1. `t=0`：学员在 `/workspace` 页面点击"启动远程桌面"（前提 `workspace.status === RUNNING`）。
2. 浏览器调 `POST /workspaces/:enrollmentId/console-session`。
3. Server 校验 owner，调 Labs 的 `browser-sessions` 接口，原样转发返回的 `{state, data?, expiresAt?}` + 附带 `guacamoleBaseUrl`。
4. 若 `state !== "ready"`：浏览器展示"VM 启动中"，2-3 秒后回到第 2 步重新请求，直到 ready 或超过 2 分钟超时。
5. `state === "ready"`：浏览器渲染 `console-viewer` 组件，POST `data` 到 Guacamole `api/tokens` 换 `authToken`。
6. 用 `authToken` 开 `guacamole-common-js` 的 WebSocket tunnel，`guacd` 转发到 VM 内网 RDP 端口。
7. 桌面画面渲染到组件内部容器，键鼠/剪贴板开始转发。
8. 学员关闭页面/离开：浏览器原生关闭 WebSocket，Guacamole/`guacd` 端检测到连接断开后自行清理，不需要额外清理代码。

## 错误处理

1. **workspace 状态不是 RUNNING**：`console-session` 直接返回 409，不调 Labs，浏览器展示"VM 还没准备好"。
2. **Labs 返回 `state !== "ready"` 超过轮询上限（2 分钟）**：浏览器展示"启动超时，请重试"，停止轮询，不无限重试。`"starting"`/`"unavailable"`/其它原始 libvirt 状态字符串一律按"还没 ready，继续轮询"处理，不做区分——调用 `console-session` 的前提已经是我们自己数据库里 `workspace.status === RUNNING`，Labs 返回非 ready 理论上只会是"VM 刚被顺手启动、还在等 RDP 端口就绪"这种暂时状态，用统一的超时兜底比区分每种状态值更简单，超时后的手动重试足以覆盖"Labs/VM 真的有问题"的情况，不需要在轮询逻辑里区分错误类型。
3. **Labs `browser-sessions` 调用本身失败**（网络错误、非 2xx）：显式返回 502/503，浏览器展示"无法连接远程桌面服务"，不能把一个没拿到 `data` 的状态误当成可以继续。
4. **Guacamole `api/tokens` 换 `authToken` 失败**（票据过期、签名校验失败、Guacamole 服务本身不可用）：这是浏览器直连 Guacamole 这一跳的失败，跟"服务端转发失败"分开展示——提示"远程桌面服务暂时不可用，请重试"。
5. **WebSocket tunnel 层连不上**（Tunnel 路由配错、Guacamole webapp 没在跑）：跟第 4 条同一层但更晚失败，`guacamole-common-js` 会通过 tunnel 的 `onerror`/状态回调暴露，组件按此展示明确错误，不假装还在连接。
6. **RDP 握手本身失败**（VM 内 xrdp 没就绪、凭据问题——理论上不该发生，因为 Labs 现取现塞的凭据应该总是有效，但仍要处理）：展示 `guacamole-common-js` 报的真实错误，不回退到假画面。
7. **页面关闭/离开**：浏览器原生关闭 WebSocket，`guacd`/Guacamole 端跟着清理，不需要额外清理逻辑。

## 测试

- **Server**：`console-session` 接口按现有 `workspace.controller.spec.ts`/`workspace.service.spec.ts` 的写法（mock `LabsClient.createBrowserSession`）补单元/集成测试，重点覆盖错误处理第 1/3 条（状态校验、Labs 调用失败）以及 `state` 透传的几种取值。`labs-client.spec.ts` 补 `createBrowserSession` 的测试（复用现有 `createVm`/`getCredentials` 测试的 mock 模式）。`workspace.gateway.spec.ts` 不动。
- **浏览器 `guacamole-common-js` 集成**：无法很好 mock，用手动验证清单：
  - [ ] VM 是 RUNNING 时点击"启动远程桌面" → 展示"启动中"（如果 VM 之前是关机状态）或直接进入连接 → 几秒内看到真实桌面画面 → 可以用键鼠操作、剪贴板同步正常
  - [ ] VM 不是 RUNNING 时点击 → 展示"VM 还没准备好"，不发起任何 Labs 调用
  - [ ] 轮询超过 2 分钟未 ready → 展示超时错误，停止轮询
  - [ ] Guacamole webapp 没起/Tunnel 路由配错 → 展示明确的"无法连接"错误，不是卡死转圈
  - [ ] 关闭/离开页面 → WebSocket 连接正常关闭，Labs 主机上 Guacamole 的会话跟着清理

**第一优先级任务：spike 验证 `guacamole-common-js` 1.5.0 客户端库对 Guacamole 1.6.0 服务端的真实连接参数**——`Guacamole.Client.connect()` 的连接字符串参数格式（`token`/`GUAC_DATA_SOURCE`/`GUAC_ID` 等具体 key）需要对着 1.6.0 版本实测，不能只凭文档假设两个次版本号之间兼容。在写周边的服务端/客户端胶水代码之前，先花一个任务把最小可行路径跑通：本地 Docker Compose 起一份 1.6.0 版本的 `guacd` + `guacamole`，手工用 Node 脚本按 Labs `_encrypt_guacamole_payload` 同样的算法（HMAC-SHA256 签名 + AES-128-CBC 零 IV 加密）构造一个 `data` 票据，验证"拿 `data` 换 `authToken` → 开 WebSocket tunnel → 看到真实桌面画面"这条路径可行。如果这一步跑不通，需要重新评估是否要在 `aivirteach-server` 里加一层服务端代理 Guacamole 的 REST 调用（而不是浏览器直接跨域调 `api/tokens`），所以必须在其余任务之前做。

## 部署清单更新

这份设计落地后，需要更新 [`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md)：

- 第 1a 节（`websockify` 部署）整段删除，改成"确认 Labs 主机上 Guacamole（`vm_agent_local` 分支的 Docker Compose）已经在跑"——这部分不是我们仓库的部署步骤，只需要一个核对清单指向同事负责的 `aivirteach-labs` 文档。
- Tunnel ingress 表格里 `labs-console.<domain>` 指向的本地端口从 `6080`（websockify）改成 Guacamole webapp 实际监听的端口（Docker Compose 里是 `8080`，对外映射需要跟同事核对实际值）。
- `labs-vm.<domain>` 的 Access Application 不变，只是新增一条 `browser-sessions` 路由，不需要新的 Access 配置。
- 新增 `AIVIRTEACH_SESSION_TOKEN`、`LABS_GUACAMOLE_BASE_URL` 到 server 端需要配置的环境变量清单，`LABS_CONSOLE_WS_URL` 从清单里删除。
- 第 5a 节（连通性验证）的排障指引改成针对 Guacamole/`guacamole-common-js` 的失败模式（`api/tokens` 换 token 失败 vs. WebSocket tunnel 连接失败 vs. RDP 握手失败），不再是 IronRDP 特有的排障内容。

这次不在这份设计文档里直接改那份部署清单，等实现阶段验证过配置确实可行后再更新，延续 IronRDP 版设计"文档记的是验证过的事实，不是计划"的原则。
