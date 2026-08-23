# Console/RDP 远程桌面接入设计：浏览器内嵌 IronRDP + websockify 直连 Labs VM

## 背景

[Workspace VM 编排设计](./2026-08-22-workspace-vm-orchestration-design.md)（"前半段"，`aivirteach-server` PR #8、`aivirteach-client` PR #3）已经实现：学员在 `/workspace` 页面触发 Labs 建 VM，通过 WebSocket 收到状态更新（`CREATING`/`RUNNING`/`ERROR`）。但那份设计明确排除了"学员怎么真正连上 VM 桌面"这件事，留到"后半段单独立项"。

这份设计就是后半段：学员点一下，在同一个 `/workspace` 页面里直接看到、操作自己那台 VM 的真实图形界面——不需要安装任何东西。

**这是对已批准过一版设计的替代，不是补充。** 此前有一版基于 Tauri（Rust + WebView）原生桌面客户端的设计（`aivirteach-client` 的 `vm_vlient` 分支）已经写完完整实现计划，讨论过程中出于"想要跨平台、这只是个快速 MVP"的考虑，改为纯浏览器方案。原生客户端方向作废，本文档取代之前的版本。

## 关键事实核对

- VM 里跑的是 xrdp（`aivirteach-labs/libvirt/scripts/create-learner-vm.sh` 里 cloud-init 装的），RDP 是学员使用的主协议。
- QEMU 层的 VNC（`vm-control.sh vnc`）只绑定 Labs 主机的 `127.0.0.1`，端口是 `5900+display号`，照出的是物理控制台画面，跟 xrdp 开的桌面会话不是同一个东西，只适合底层诊断，不适合作学员桌面入口。
- RDP（VM 内部 3389 端口）只能从 Labs 主机通过 libvirt 的 NAT 网桥 `virbr0`（`192.168.122.0/24`）到达，外网/学员浏览器都够不着，必须有个东西从 Labs 主机内部转发出来——而且浏览器没法像原生客户端那样自己开 TCP socket，只能用 WebSocket。
- **`ironrdp-web`**：IronRDP 项目（跟原来 `vm_vlient` 用的 `ironrdp` Rust crate 是同一套底层实现）官方维护的浏览器 WebAssembly 构建，Devolutions Gateway 的免费 Web 界面、Cloudflare 自家的浏览器 RDP 方案都是拿它做生产环境用的，不是实验性玩具。提供 RDP 连接、键鼠/滚轮输入、剪贴板同步，直接在浏览器里跑。浏览器本身无法开原始 TCP socket——需要一个 WebSocket↔TCP 的桥接层。
- **`websockify`**：成熟的现成工具（最早给 noVNC 用的），负责 WS↔TCP 原始字节转发，跟具体协议无关。它的 `--token-plugin=TokenFile --token-source=<目录>` 模式支持"一个进程、按 token 动态路由到不同后端目标"——目录里每个文件名是一个 token，内容是 `<token>: <host>:<port>`，这正是 OpenStack Horizon/noVNC 给多 VM 控制台代理用的机制。用这个可以让一个 websockify 进程服务所有学员，不用给每个 VM 起一个转发进程。
- `aivirteach-labs` 的 `vm-control.sh credentials` 命令已经能读出 RDP 用户名密码（`GET /v1/vms/{lab_id}/credentials` 接口已存在），字段名是 `password`（不是 `rdp_password`，那是创建接口响应里的字段名，容易搞混）。这次还需要给 Labs 加一个新接口，见下方"组件设计"。
- Cloudflare Tunnel 本身免费，Labs 主机已经在用（见 [`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md)）。这次只需要给 Tunnel 新增一条普通的 WSS 可用的 HTTP hostname 路由指到 `websockify` 监听的本地端口，**不需要** Cloudflare Access 私有网络应用、不需要 Access Service Token、不需要管 `cloudflared` 版本锁定——这些都是上一版 Tauri 设计里"客户端直连内网"才需要的机制，纯浏览器方案完全绕开了。
- Server 端已有"生成随机不透明 token"的工具函数可以直接复用：`src/auth/tokens.ts` 的 `generateOpaqueToken()`（32 字节随机数，base64url）。这次不需要复用 `Invitation` 模型那套哈希存储模式——原因见下方"设计原则"。

## 不做的事（明确排除的范围）

- **不做原生桌面客户端**——`vm_vlient`/Tauri/Rust 方向已经作废，不再基于它继续开发。
- **不搭 Guacamole**——它是成熟方案，但要自建 `guacd` C 守护进程、历史上常搭配 Tomcat/Java，长期维护成本比复用 `ironrdp-web`（跟原生方案同源）+ 现成 `websockify` 高，图形密集场景延迟也有文档记录的劣势。
- **不引入 Cloudflare Access Service Token 层**——一次性 routing token 本身的高熵值 + Labs 主机现有 Cloudflare Tunnel（本来就不直接暴露在公网）被认为对 MVP 已经够用。
- **不做严格的单次核销**——token 只在"生成"这一步保证唯一（`generateOpaqueToken()` 的随机性），但 `websockify` 的 `TokenFile` 层本身不支持"用过一次就失效"，靠 TTL 兜底（token 文件几分钟后被清理）。这意味着理论上同一个 token 在过期前可以被重复用来发起连接。MVP 范围内接受这个简化，已经跟用户确认过。
- **不给学员开放 VM 生命周期控制**（重启/关机/强制重置）——这轮只做"看到、操作桌面"本身，出问题走诊断 agent 或人工介入。
- **诊断 Agent（8770 端口）集成**——不在这轮范围，`labs-agent.<domain>` 仍然只是预留 hostname。
- **跨平台适配不再是一个需要单独排除的问题**——浏览器方案天然跨平台，这条排除项随 Tauri 方向一起作废。

## 设计原则

- **单层短效 token，只做路由，不做身份验证**：学员点击按钮时的身份已经由 `/workspace` 页面现有的 JWT 会话验证过了，这次新增的一次性 token 唯一的作用是告诉 `websockify`"这个 WebSocket 连接该转发到哪台 VM"，不再需要像上一版 Tauri 设计那样用它去跨越浏览器到原生进程的信任边界。5 分钟有效期，绑定单个 workspaceId。
- **不为一次性 routing token 建数据库表**——这是写这份文档时发现的、比上一版更简单的方案，主动指出来：上一版设计需要"发放 token → 之后另一次独立请求用 token 兑换"两步握手（因为要跨越浏览器到 Tauri 进程的边界），所以需要把 token 哈希存库，供第二次请求核对。这一版里，token 的生成、注册给 Labs、返回给浏览器全部发生在**同一个** HTTP 请求处理函数里，没有"之后另一次独立请求"这回事，落库查不到任何东西——所以不建 `ConsoleHandoff` 之类的 Prisma model，`generateOpaqueToken()` 生成完直接用，不落库。
- **`rdp_password` 现取现用现扔**：延续前半段 `labs-client.ts`"故意不读取、不透出 `rdp_password`"的原则——这次用到它时，服务端现问 Labs 现要，直接透传给浏览器响应，不落库、不记日志。终点从原生进程内存变成浏览器 JS 内存，只在 `ironrdp-web` 握手那一下用一次；跟原生进程比，浏览器没法"主动清零内存"，这是纯浏览器方案的固有取舍，不是本设计能解决的问题，明确记录在这里而不是假装没有。
- **复用现成工具，不重新发明**：`websockify` 做 WS↔TCP 转发，`ironrdp-web` 做 RDP 协议和渲染，都是别人已经做好、验证过的东西；新写的代码只是"服务端一个接口 + Labs 一个接口 + 网页里嵌一个组件"这三块胶水。

## 架构

**阶段一：学员点击按钮，服务端准备连接**

```
┌────────────────────┐     ①POST /workspaces/:id/     ┌────────────────────────┐
│    /workspace 网页    │        console-session          │     aivirteach-server    │
│  (Next.js，已有 JWT    │────────────────────────────────>│     (NestJS, Vercel)     │
│   会话，PR #3)         │                                 │                          │
│                     │                                 │  校验 owner + status     │
│                     │                                 │  = RUNNING               │
│                     │                                 │  生成一次性 token         │
│                     │                                 │  (generateOpaqueToken)   │
│                     │                                 └────────────┬─────────────┘
│                     │                                              │
│                     │                          ②POST /v1/vms/{id}/console-token
│                     │                            {token, ttlSeconds}
│                     │                                              ▼
│                     │                                 ┌────────────────────────┐
│                     │                          ③GET /v1/vms/{id}/  aivirteach-labs │
│                     │                            credentials       (FastAPI)     │
│                     │                                 │  写 websockify           │
│                     │                                 │  TokenFile 条目           │
│                     │                                 │  (顺带清理过期文件)        │
│                     │                                 └────────────┬─────────────┘
│  ④拿到 wsUrl/         │<────────────────────────────────────────────┘
│    rdpUsername/      │
│    rdpPassword       │
└──────────┬──────────┘
```

**阶段二：浏览器直接建立 RDP 会话**

```
┌────────────────────┐   ⑤WebSocket 连接    ┌──────────────────────┐   ⑦查 TokenFile   ┌──────────────────┐
│  ironrdp-web (WASM)  │  wss://labs-console. │      websockify        │   找到目标 ip:port  │  Labs 主机内网 VM   │
│  组件，嵌在 /workspace │  <domain>/?token=…   │  (TokenFile 插件)       │────────────────>│  192.168.122.x:3389│
│  页面里               │──────────────────────>│  监听在 Labs 主机本地端口 │<────────────────│  (xrdp)            │
│                     │                       │  通过 Cloudflare       │   ⑧RDP 协议数据    └──────────────────┘
│  ⑥完成 RDP 握手,       │<──────────────────────│  Tunnel 暴露            │   (WS 包裹)
│    渲染桌面到 canvas,   │   RDP 数据 (WS 包裹)   └──────────────────────┘
│    键鼠/剪贴板转发       │
└────────────────────┘
```

## 组件设计

### Server：`aivirteach-server`

**不新增 Prisma model**（原因见"设计原则"）。

**`src/workspace/labs-client.ts` 新增两个方法**：

```typescript
export type VmCredentials = {
  rdpUsername: string;
  rdpPassword: string;
};

async getCredentials(labId: string): Promise<VmCredentials> {
  // 同 createVm：缺配置抛 ServiceUnavailableException，非 2xx 抛格式化 Error
  // GET `${LABS_VM_BASE_URL}/v1/vms/${labId}/credentials`，带同样的 Authorization + CF-Access 头
}

async registerConsoleToken(labId: string, token: string, ttlSeconds: number): Promise<void> {
  // POST `${LABS_VM_BASE_URL}/v1/vms/${labId}/console-token`
  // body: { token, ttlSeconds }
  // 非 2xx 抛格式化 Error，跟 createVm/getCredentials 同一套错误处理风格
}
```

**`src/workspace/workspace.controller.ts` 新增一个接口**：

- `POST /workspaces/:enrollmentId/console-session`：走现有的 class-level `JwtAuthGuard`（不像上一版 Tauri 设计那样需要单独放开鉴权——调用方就是已登录学员本人的浏览器）。校验调用者是该 enrollment 的 owner 且 `workspace.status === RUNNING`；生成一次性 token（`generateOpaqueToken()`，不落库）；调 `LabsClient.registerConsoleToken()` 把 token 和 5 分钟 TTL 登记给 Labs；调 `LabsClient.getCredentials()` 现取用户名密码；组装返回：

```typescript
type ConsoleSessionResponse = {
  wsUrl: string; // `${LABS_CONSOLE_WS_URL}/?token=${token}`
  rdpUsername: string;
  rdpPassword: string;
  expiresAt: string; // ISO 时间戳，纯展示用（"链接 5 分钟后过期"提示）
};
```

**`src/config/env.ts` 新增环境变量**：`LABS_CONSOLE_WS_URL`（`websockify` 对外的 wss:// 基础地址，比如 `wss://labs-console.<domain>`，跟现有 `LABS_VM_BASE_URL`——那个是 VM Manager HTTP API 的地址——是两个不同用途的配置）。不需要新增任何 Cloudflare Access 相关的环境变量（上一版的 `CF_ACCESS_CONSOLE_CLIENT_ID`/`SECRET` 整个作废）。

### Client：`aivirteach-client` 的 `feat/workspace-vm-orchestration`（PR #3）

- 新增一个客户端组件（比如 `app/workspace/console-viewer.tsx`），封装 `ironrdp-web` 的浏览器 Web 组件（IronRDP 官方维护，具体 npm 包名/引入方式作为实现计划的第一个任务去调研+验证，见"测试"一节的 spike 任务——这是本设计里唯一没有先例验证过的集成点，其余部分都是复用有文档、有实际生产案例的现成组件）。
- 这个组件必须是纯客户端组件（`"use client"`，只在 `useEffect`/事件回调里碰 `window`/`WebAssembly`），因为 `aivirteach-client` 用 `vinext`/`wrangler`/`@cloudflare/vite-plugin` 的 Cloudflare Workers 风格构建——WASM 模块不能在 SSR/Workers 运行时那一侧被执行，只能在浏览器 hydrate 之后跑。
- 组件 props：`wsUrl`、`rdpUsername`、`rdpPassword`；内部行为：建立 WebSocket 连接、完成 RDP 握手、把画面渲染到内部 `<canvas>`、转发键鼠/滚轮/剪贴板事件；对外暴露 `onConnect`/`onError`/`onDisconnect` 回调，方便页面展示对应状态。
- `app/workspace/page.tsx`（已实现的部分）加"启动远程桌面"按钮：调 `console-session`，拿到响应后把 `console-viewer` 组件渲染出来（比如展开一个面板/modal），不再有 deep link、不再需要"客户端未安装"检测这类逻辑——这是纯浏览器方案省掉的一整类复杂度。

### Labs：`aivirteach-labs`

**`libvirt/scripts/vm-control.sh` 新增一个子命令**（跟现有 `credentials`/`ip`/`vnc` 子命令并列）：

- `register-console-token <lab_id> <token> <ttl_seconds>`：先清理 token 目录里 mtime 超过 TTL 的旧文件（`find <目录> -mmin +5 -delete` 这类逻辑），再查出这台 VM 的内网 IP 和 RDP 端口（复用现有查 IP/查 credentials 的逻辑），写一个新文件到 `websockify` 的 `TokenFile` 目录：`<token>: <internal_ip>:<rdp_port>`。这样清理逻辑跟着每次注册顺带执行，不需要额外配一个 cron。

**`service.py` 新增一个路由**：

- `POST /v1/vms/{lab_id}/console-token`：解析 body 里的 `token`/`ttlSeconds`，调用上面的 `vm-control.sh register-console-token`，跟现有路由一样的鉴权方式（Authorization + CF-Access 头）。

**运维新增**（不是应用代码，属于部署清单范畴）：`websockify` 作为一个服务跑在 Labs 主机上（比如 `systemd` 管理），带 `--token-plugin=TokenFile --token-source=<目录>` 参数监听本地端口；Cloudflare Tunnel 新增一条普通 WSS hostname 路由（`labs-console.<domain>` → `http://localhost:<websockify端口>`），不是 Access 私有网络应用。具体启动参数、目录权限留到实现阶段验证。

## 数据流（创建连接的完整时序）

1. `t=0`：学员在 `/workspace` 页面点击"启动远程桌面"（前提 `workspace.status === RUNNING`，页面已有这个状态）。
2. 浏览器带着现有 JWT 会话调 `POST /workspaces/:enrollmentId/console-session`。
3. Server 校验 owner + status，生成一次性 token（不落库）。
4. Server 调 Labs 的 `console-token` 接口登记 token→目标 VM 的映射（顺带清理旧 token 文件）。
5. Server 调 Labs 的 `credentials` 接口现取 `rdpUsername`/`rdpPassword`。
6. Server 把 `{ wsUrl, rdpUsername, rdpPassword, expiresAt }` 返回给浏览器。
7. 浏览器渲染出 `ironrdp-web` 组件，用 `wsUrl` 建立 WebSocket 连接。
8. `websockify` 收到连接，查 `TokenFile` 找到 token 对应的目标 `ip:port`，建立到 VM 内网 RDP 端口的 TCP 连接，开始双向转发字节。
9. `ironrdp-web` 在这条 WebSocket 上完成 RDP 协议握手（用第 6 步拿到的用户名密码），开始渲染桌面画面、转发键鼠/剪贴板。
10. 学员关闭页面/离开：浏览器原生关闭 WebSocket 连接，`websockify` 检测到连接断开后关闭对应的后端 TCP 连接，不需要任何额外清理代码。

## 错误处理

1. **workspace 状态不是 RUNNING**：`console-session` 直接返回 409，不生成 token、不调 Labs，浏览器展示"VM 还没准备好"。
2. **Labs 登记 token 失败**（Labs 挂了、VM 已被删除）：显式返回 502/503，绝不能返回一个实际没登记成功的 `wsUrl`。
3. **Labs 现取密码失败**：同上，502/503，绝不能返回空密码让浏览器拿着空密码硬连。
4. **WebSocket/TCP 层连不上**（`websockify` 没在跑、Tunnel 路由配错、token 文件已经被 TTL 清理掉）：这是浏览器建立 WS 连接这一步的失败，跟"RDP 握手失败"分开展示——前者提示"无法连接远程桌面服务，请重试"，后者是下面第 5 条。
5. **RDP 握手本身失败**（凭据错、xrdp 没就绪）：展示 `ironrdp-web` 报的真实错误，不回退到假画面、不吞掉错误。
6. **页面关闭/离开**：浏览器原生关闭 WebSocket，`websockify` 端跟着关闭到 VM 的 TCP 连接——不需要额外清理逻辑，比原生客户端方案简单（不用管子进程残留）。
7. **token 在 TTL 内被重复使用**：已在"不做的事"里明确记录为 MVP 范围内接受的简化，不是需要设计防御的错误场景。

## 测试

- **Server**：`console-session` 接口按现有 `workspace.controller.spec.ts`/`workspace.service.spec.ts` 的写法（mock `LabsClient` 各方法）补单元/集成测试，重点覆盖错误处理里的第 1/2/3 条（状态校验、Labs 登记失败、Labs 取密码失败）。
- **Labs**：`register-console-token` 子命令 + 新路由，参照 Labs 仓库现有的测试方式（具体写法留到写实现计划时核对，这个仓库的测试规范还没有仔细看过）。
- **浏览器 `ironrdp-web` 集成**：跟真实 RDP 连接一样没法很好 mock，用手动验证清单，比原生客户端那版短（不用测安装检测、不用测残留进程）：
  - [ ] VM 是 RUNNING 时点击"启动远程桌面" → 几秒内看到真实桌面画面 → 可以用键鼠操作、剪贴板同步正常
  - [ ] VM 不是 RUNNING 时点击 → 展示"VM 还没准备好"，不发起任何连接
  - [ ] `websockify` 没起/Tunnel 路由配错 → 展示"无法连接远程桌面服务"，不是卡死转圈
  - [ ] 关闭/离开页面 → 浏览器原生关闭连接，Labs 主机上 `websockify` 到 VM 的连接跟着断开

**第一优先级任务：spike 验证 `ironrdp-web` + `websockify` 组合可行**——这两个各自都是有生产案例的成熟工具，但"`ironrdp-web` 通过 `websockify` 转发连真实 xrdp"这个组合没有查到已知先例。在写周边的服务端/Labs 接口之前，先花一个任务把最小可行路径跑通：本地/测试环境起一个 `websockify`，配一条手工写的 `TokenFile` 记录指向一台跑 xrdp 的机器，浏览器里跑 `ironrdp-web` 连上去，能看到真实桌面画面。如果这一步跑不通，整个方案需要重新评估，所以必须在其余任务之前做。

## 部署清单更新

这份设计落地后，需要更新 [`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md)：

- `labs-console.<domain>` 从"占位保留"变成真正生效的 Cloudflare Tunnel **普通 HTTP(S)/WSS hostname 路由**（不是 Access 私有网络应用），指向 Labs 主机本地的 `websockify` 端口。
- 新增 `websockify` 服务的部署步骤（安装、`systemd` 配置、`TokenFile` 目录、启动参数）。
- 删除上一版遗留的"需要锁定 `cloudflared` 2026.5.1""需要 Access Service Token"相关内容——这些是原生客户端直连方案才需要的，纯浏览器方案不涉及。

这次不在这份设计文档里直接改那份部署清单，等实现阶段验证过配置确实可行后再更新，避免文档记的是"计划"而不是"验证过的事实"。
