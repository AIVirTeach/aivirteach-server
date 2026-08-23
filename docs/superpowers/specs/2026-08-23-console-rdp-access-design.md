# Console/RDP 远程桌面接入设计：桌面客户端直连 Labs VM

## 背景

[Workspace VM 编排设计](./2026-08-22-workspace-vm-orchestration-design.md)（"前半段"，`aivirteach-server` PR #8、`aivirteach-client` PR #3）已经实现：学员在 `/workspace` 页面触发 Labs 建 VM，通过 WebSocket 收到状态更新（`CREATING`/`RUNNING`/`ERROR`）。但那份设计明确排除了"学员怎么真正连上 VM 桌面"这件事，留到"后半段单独立项"。

这份设计就是后半段：学员点一下，能在桌面客户端里看到、操作自己那台 VM 的真实图形界面。

## 关键事实核对

- VM 里跑的是 xrdp（`aivirteach-labs/libvirt/scripts/create-learner-vm.sh` 里 cloud-init 装的），RDP 是学员使用的主协议。
- QEMU 层的 VNC（`vm-control.sh vnc`）只绑定 Labs 主机的 `127.0.0.1`，端口是 `5900+display号`，照出的是物理控制台画面，跟 xrdp 开的桌面会话不是同一个东西，只适合底层诊断，不适合作学员桌面入口。
- RDP（VM 内部 3389 端口）只能从 Labs 主机通过 libvirt 的 NAT 网桥 `virbr0`（`192.168.122.0/24`）到达，外网/学员的电脑都够不着，必须有个东西从 Labs 主机内部转发出来。
- `aivirteach-client` 仓库里已经有一个未合并的 `vm_vlient` 分支（无对应 PR），是一个 **Tauri（Rust + WebView）原生桌面应用 Demo**：Rust 用 `ironrdp` crate 直接建 RDP 会话、解码画面为 RGBA 帧，React 只负责把帧画到 `<canvas>`，键鼠事件原生转发。README 原话："界面不会生成或模拟远程桌面"。
  - 现状：Windows-only（用 `ssh.exe`、Windows 凭据管理器存密码）；SSH 隧道写死连 `arclab@10.162.179.63` 这个跳板机，目标写死 `192.168.122.210:3389`。
  - 但 `RdpRequest` 结构体（`src-tauri/src/lib.rs`）已经是参数化的（`bastion_host`/`bastion_user`/`target_host`/`target_port`/`rdp_username`/`rdp_password`/`rdp_domain` 等都是前端传参进 Rust），不是硬编码，改造成本主要在"参数从哪来"，不是重写 Rust 核心逻辑。
- `aivirteach-labs` 的 `vm-control.sh credentials` 命令已经能读出 RDP 用户名密码（`GET /v1/vms/{lab_id}/credentials` 接口已存在），Labs 应用代码不需要为这次改动。
- Cloudflare（2026 现状）：Tunnel 本身免费；Access 50 用户以内免费，超过 $7/用户/月——按 demo 规模，这次不涉及额外成本。`cloudflared access tcp`/`access rdp` 是官方支持的私有网络 TCP 转发功能（2025-10 起 Access 私有网络应用支持任意端口/协议，不是临时拼凑）。
  - 已知风险：`cloudflared` 2026.6.0 有回归 bug，`access tcp`/`access ssh` 会忽略 service token 的免交互认证，退化成弹浏览器登录（[cloudflare/cloudflared#1673](https://github.com/cloudflare/cloudflared/issues/1673)），2026.5.1 版本正常。客户端捆绑的 `cloudflared` 必须锁定 2026.5.1。
- Server 端已有"一次性、哈希存储"的 opaque token 模式可以直接复用：`prisma/schema.prisma` 的 `Invitation` 模型（`tokenHash String @unique`、`expiresAt`、`acceptedAt`）+ `src/auth/tokens.ts` 的 `generateOpaqueToken()`（32 字节随机数，base64url）/`hashOpaqueToken()`（SHA-256），`AuthService.acceptInvitation()` 是这个模式的参考实现。

## 不做的事（明确排除的范围）

- **不用浏览器/Guacamole 方案**——明确要原生 Rust 客户端，不是网页里的远程桌面。这一点在讨论中反复确认过。
- **不给学员开放 VM 生命周期控制**（重启/关机/强制重置）——这轮只做"看到、操作桌面"本身，出问题走诊断 agent 或人工介入。
- **不做跨平台**（Mac/Linux）——继续跟 `vm_vlient` 现有 Demo 一样只做 Windows，这块后续如果要做是独立的后续工作。
- **不给 Rust 客户端搭建自动化测试框架**——`ironrdp`/子进程这些本来就不好 mock，这轮按"demo 打通真实连接 + 完整下载安装体验"的范围来，用手动验证清单代替，这个处理方式跟前半段"Labs 真实网络这段测不了、写清楚靠人工过一遍"是同一个原则，不是双重标准。Server 侧新增接口仍然要写自动化测试。
- **诊断 Agent（8770 端口）集成**——不在这轮范围，`labs-agent.<domain>` 仍然只是预留 hostname。

## 设计原则

- **两层凭据，两种生命周期，都不硬编码进客户端安装包**：
  - 短效层：一次性、绑定单个 workspaceId 的 handoff token，5 分钟有效期，用一次即废——解决"这次连接是不是这个学员本人发起的、要连他自己那台 VM"。
  - 长效层：Cloudflare Access Service Token，月度轮换、集中管理——解决"这是不是我们认可的客户端 App 在敲门"这个网络层粗粒度门禁，不区分具体是哪个学员。
  - 两者都在同一次 token 换取请求（见下方"数据流"）里由 server 现发给客户端，不写死在发布的安装包里——写死的密钥任何装了 App 的人都能反编译拿到，形同公开；运行时下发意味着轮换只需要改 server 配置，不需要重新发布客户端。
- **`rdp_password` 绝不落库**：延续前半段 `labs-client.ts`"故意不读取、不透出 `rdp_password`"的原则——这次终于要用它的时候，也是现取现用现扔，只活在 Rust 进程内存里，断开连接就清除。
- **复用现有代码模式，不重新发明**：一次性 token 直接复用 `Invitation` 模型 + `src/auth/tokens.ts` 的哈希存储模式，不额外造一套机制。

## 架构

```
┌─────────────────┐         ┌──────────────────────┐         ┌──────────────────────┐
│  /workspace 网页  │         │   aivirteach-server   │         │    aivirteach-labs    │
│  (Next.js, 已有)  │         │   (NestJS, Vercel)     │         │  (FastAPI + libvirt)  │
│                  │ ①点击    │                        │         │                       │
│  "启动客户端"按钮  │────────>│  POST .../console-token│         │                       │
│                  │ ②token  │  (发一次性 token)        │         │                       │
│                  │<────────│                        │         │                       │
│  触发 deep link   │         │                        │         │                       │
└────────┬─────────┘         │  POST /workspaces/      │         │  GET /v1/vms/{id}/    │
         │ ③ aivirteach-      │    console-session      │  ⑤现取   │    credentials         │
         │   console://       │  (换真实连接信息，        │────────>│                       │
         │   connect?token=…  │   token 立即失效)        │<────────│  (rdp_password 等)    │
         ▼                   └───────────┬────────────┘         └──────────────────────┘
┌──────────────────┐                     │ ⑥返回 ip/rdpPort/
│ vm_vlient 桌面客户端│<────────────────────┘   rdpUsername/rdpPassword/
│  (Tauri + Rust)   │  ④调用 console-session   cfAccessClientId/Secret
│                   │
│  cloudflared       │  ⑦ Access 私有网络 TCP 隧道（长效层门禁）
│  access tcp/rdp   │─────────────────────────────────┐
│  (锁定 2026.5.1)   │                                  ▼
│                   │                        ┌──────────────────────┐
│  ironrdp 建 RDP    │  ⑧ RDP（短效层密码）       │   labs-console.<domain>│
│  会话，原生渲染      │─────────────────────────>│   → Labs 主机内网 VM   │
└──────────────────┘                          └──────────────────────┘
```

## 组件设计

### Server：`aivirteach-server`

**Prisma schema 新增**（镜像 `Invitation` 模型的模式）：

```prisma
model ConsoleHandoff {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  tokenHash   String    @unique
  expiresAt   DateTime
  redeemedAt  DateTime?
  createdAt   DateTime  @default(now())

  @@index([workspaceId])
}
```

`Workspace` 模型加一行反向关系 `consoleHandoffs ConsoleHandoff[]`。

**`src/workspace/labs-client.ts` 新增方法**：

```typescript
export type VmCredentials = {
  rdpUsername: string;
  rdpPassword: string;
  rdpPort: number;
};

async getCredentials(labId: string): Promise<VmCredentials> {
  // 同 createVm：缺配置抛 ServiceUnavailableException，非 2xx 抛格式化 Error
  // GET `${LABS_VM_BASE_URL}/v1/vms/${labId}/credentials`，带同样的 Authorization + CF-Access 头
}
```

**`src/workspace/workspace.controller.ts` 新增两个接口**：

- `POST /workspaces/:enrollmentId/console-token`：校验调用者是该 enrollment 的 owner 且 `workspace.status === RUNNING`，生成 `generateOpaqueToken()`，存 `hashOpaqueToken()` 后的值 + 5 分钟后的 `expiresAt`，返回原始 token（明文只在这一次响应里出现，之后只存哈希）。
- `POST /workspaces/console-session`：body 带 `token`。查 `ConsoleHandoff`，校验存在、未过期、未被兑换（`redeemedAt === null`）；**原子标记已兑换**（`updateMany({ where: { id, redeemedAt: null }, data: { redeemedAt: new Date() } })`，用受影响行数判断竞态，不能"先查后写"）；重新查一次当前 `workspace.status`，非 `RUNNING` 就拒绝；调 `LabsClient.getCredentials()` 现取密码；从 `ENV` 读取新增的 Access Service Token 环境变量；组装并返回连接信息。

**`src/config/env.ts` 新增环境变量**：`CF_ACCESS_CONSOLE_CLIENT_ID`、`CF_ACCESS_CONSOLE_CLIENT_SECRET`（学员客户端用的 Access Service Token，跟现有 `CF_ACCESS_CLIENT_ID`/`SECRET`——server 调 Labs VM Manager API 用的那对——是两个不同用途的凭据，分开配置、分开轮换）。

### Client：`aivirteach-client` 的 `vm_vlient` 分支（在此分支基础上继续加，暂无 PR，做完后新开一个）

- 注册自定义协议 `aivirteach-console://`（Tauri deep link 插件），处理 `connect?token=…`。
- 客户端启动/唤醒后，用 token 调 `POST /workspaces/console-session`，拿到的 `ip`/`rdpPort`/`rdpUsername`/`rdpPassword`/`cfAccessClientId`/`cfAccessClientSecret` 填进现有的 `RdpRequest` 结构（字段基本能直接对上，`bastion_host`/`bastion_user` 这两个 SSH 专属字段换成 `cloudflared access tcp` 需要的目标 hostname + Access 凭据）。
- 现有"先起子进程开本地端口转发，再让 `ironrdp` 连本地端口"的结构不变，只是子进程从 `ssh.exe` 换成捆绑的 `cloudflared access tcp`（锁定 2026.5.1）。
- 网页侧（`app/workspace/page.tsx`，已实现的部分）加"启动客户端"按钮：调 `console-token`，触发 deep link；做"客户端未安装"的检测兜底（触发后几秒内页面仍可见/未失焦，判定唤起失败，切换成下载引导）。

### Labs：`aivirteach-labs`

应用代码不需要改动。需要的是主机上的 Cloudflare Tunnel 配置变更（运维工作，见下方"部署清单更新"）。

## 数据流（创建连接的完整时序）

1. `t=0`：学员点击 `/workspace` 上的"启动客户端"（前提 `workspace.status === RUNNING`）。
2. Server 签发一次性 token（5 分钟有效期，绑定这一个 workspaceId，尚未兑换）。
3. 浏览器触发 deep link：`aivirteach-console://connect?token=…`。
4. OS 弹出"是否打开 XX 客户端？"，学员确认；未安装客户端时这一步不会触发，网页要有兜底检测。
5. 客户端启动/唤醒，捕获 URL 里的 token。
6. 客户端拿 token 调 `console-session`；server 校验通过的瞬间原子标记该 token 已兑换，不能再用第二次。
7. Server 重新校验 workspace 当前状态仍是 `RUNNING`，现取 `rdp_password`（问 Labs 的 `/v1/vms/{lab_id}/credentials`，不落库），连同 Access Service Token 一起返回。
8. 客户端用 Access Service Token 过 `cloudflared access tcp/rdp` 的网络门禁（长效层），用第 7 步的一次性密码建立 RDP 会话（`ironrdp`，原生渲染）。
9. 断开连接：密码从 Rust 进程内存清除（除非学员主动勾选"记住密码"写入系统凭据管理器），关闭 `cloudflared` 子进程。

## 错误处理

1. **客户端未安装**：deep link 未注册协议处理器，浏览器无明确反馈。网页侧检测超时/失焦，失败则展示下载引导。
2. **Token 过期或已被兑换**：`console-session` 返回明确的 401/410，客户端展示"链接已过期，请回网页重新点击"。
3. **VM 状态在换 token 期间变化**（点击时 RUNNING，兑换时已 ERROR/被删）：`console-session` 重新查一次当前状态，不信 token 里的旧状态，非 RUNNING 就拒绝并返回对应错误。
4. **Labs 现取 `rdp_password` 失败**（Labs 挂了、凭据文件不存在）：显式返回 502/503，绝不能返回空密码让客户端拿着空密码硬连。
5. **一次性 token 的重放竞态**：用 `updateMany` + 受影响行数判断而非"先查后写"，保证并发请求下只有一次成功。
6. **`cloudflared` 子进程起不来 / Access 认证被拒**：新增的第三类错误（网络/门禁层），要跟现有 Demo 已经区分好的 SSH 层错误、RDP 层错误分开展示，不能混在一起让学员分不清是网络问题还是密码问题。
7. **RDP 握手本身失败**：沿用现有 Demo 的处理（展示 RDP 返回的真实错误，不回退到假画面）。
8. **断开/退出时的清理**：内存密码清除、关闭 `cloudflared` 子进程和 RDP 会话，不留后台残留——Demo 已处理，照搬。

## 测试

- **Server**：`console-token`/`console-session` 两个接口按现有 `workspace.controller.spec.ts`/`workspace.service.spec.ts` 的写法补单元/集成测试，重点覆盖错误处理里的第 2/3/4/5 条（token 过期、状态重新校验、Labs 凭据获取失败、并发重放）。
- **Client（Rust/Tauri）**：不搭建自动化测试框架（见"不做的事"）。改为手动验证清单：
  - [ ] 客户端已安装：网页点击 → 弹出确认框 → 拉起客户端 → 自动连上、看到真实桌面
  - [ ] 客户端未安装：网页点击 → 检测到未拉起 → 展示下载引导
  - [ ] Token 过期后才点确认框：客户端展示明确的"链接已过期"错误
  - [ ] VM 在换 token 期间被删除/出错：客户端展示对应错误，不是空白或卡死
  - [ ] 断开连接后，任务管理器里没有残留的 `cloudflared`/RDP 相关进程

## 部署清单更新

这份设计落地后，需要把 [`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md) 里"明确不在这份清单范围内"一节中"Console/VNC 直连 Labs（Guacamole 网关）——单独立项……这次不需要建对应的 Access Application"这句话删掉，换成实际生效的配置：

- `labs-console.<domain>` 从"占位保留"变成真正生效的 **Cloudflare Access 私有网络应用**（TCP/RDP，不是 HTTP hostname 路由），指向 Labs 主机内部的 VM 网段。
- 新建一对**学员客户端专用**的 Access Service Token（对应 server 端新增的 `CF_ACCESS_CONSOLE_CLIENT_ID`/`SECRET`），跟 server 调 Labs VM Manager API 用的那对 Service Token 分开建、分开轮换。
- 明确提醒：Labs 主机和客户端捆绑的 `cloudflared` 都必须锁定 **2026.5.1**，不能跟随最新版（2026.6.0 的 service token 回归 bug，见"关键事实核对"）。

这次不在这份设计文档里直接改那份部署清单，等实现阶段验证过配置确实可行后再更新，避免文档记的是"计划"而不是"验证过的事实"。
