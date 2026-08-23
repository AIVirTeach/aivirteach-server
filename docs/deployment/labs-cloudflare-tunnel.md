# Labs Cloudflare Tunnel 部署清单

> 面向负责 Cloudflare Tunnel / Access 配置的同事。这里全是 Cloudflare 后台配置 + Labs 主机上装
> `cloudflared`/`websockify`，不涉及写代码。基于 `aivirteach-server` PR #8（workspace VM 编排）+
> PR #9（Console/RDP 浏览器接入）和 `aivirteach-labs`/`aivirteach-client` 仓库当前实际代码核对，
> 取代设计文档里那份写在实现之前的旧清单。

## 现状核对：server 端实际会调用什么

`src/workspace/labs-client.ts` 现在调用 Labs 的三个接口：`POST /v1/vms`（建 VM）、
`GET /v1/vms/{labId}/credentials`（取 RDP 密码，只透出 `password` 字段）、
`POST /v1/vms/{labId}/console-token`（登记 websockify 路由 token）。没有调用诊断/agent 相关接口。
对应 `src/config/env.ts` 里实际加的 5 个环境变量：

```
LABS_VM_BASE_URL=https://<labs-vm 的 tunnel 域名>
LABS_CONSOLE_WS_URL=wss://<labs-console 的 tunnel 域名>
AIVIRTEACH_API_TOKEN=<和 Labs 主机 config/api.env 里同名变量的值完全一致>
CF_ACCESS_CLIENT_ID=<下面第 2 步生成的 Service Token>
CF_ACCESS_CLIENT_SECRET=<下面第 2 步生成的 Service Token>
```

这五个都在 server 里标记为**可选**（不配置的话，本地/CI 照常跑，只有真正调用 `LabsClient`/
`createConsoleSession` 时才报错），所以这份清单不是"必须立刻做完 server 才能跑"，而是"要让
`/workspace` 页面真的建出 VM、真的能打开远程桌面，必须做完"。

**`LABS_CONSOLE_WS_URL` 跟 `LABS_VM_BASE_URL` 是两个不同用途、不同保护方式的地址，不要混淆**（见
下面第 1a、2 节）：前者是浏览器直连的 WebSocket 地址，不能挂 Cloudflare Access；后者是 server 到
Labs 的 HTTP API，必须挂 Cloudflare Access。

`LABS_AGENT_BASE_URL`（诊断 agent 用）**当前没有在 server 代码里出现** —— Console/诊断功能还在
"未来单独立项"阶段（见设计文档"不做的事"一节），所以本轮不需要为 `labs-agent` 配 Access + Service
Token，只需要预留路由位置（见下面第 1 步第 3 条）。

## 1. Labs 主机上实际跑的服务（核对自 `aivirteach-labs` 仓库）

Labs 是三个独立进程，各自 systemd unit，默认全部绑定 `127.0.0.1`（见
`aivirteach-labs/config/api.env.example`），不能从外网直连，必须靠本机的 `cloudflared` 转发：

| 端口 | systemd unit | 作用 | 这次要不要接 Tunnel |
| --- | --- | --- | --- |
| `8760` | `aivirteach-labs.service` | VM Manager（`POST /v1/vms`、`GET .../credentials`、`POST .../console-token` 都在这） | **要**，server 直接调用它 |
| `8765` | `aivirteach-labs-gateway.service` | 只读诊断 Gateway | **不要**——README 里写死只接受来自 `127.0.0.1:8760` 的请求，对外暴露没有意义，反而多一个攻击面 |
| `8770` | `aivirteach-agent.service` | 课程感知诊断 Agent | 暂不需要，server 还没有调用它的代码 |
| （新起，端口自选，建议 `6080`） | 新建，比如 `aivirteach-console-proxy.service` | `websockify`，见下面第 1a 节 | **要**，浏览器直接连它 |

Tunnel ingress 规则：

```
labs-vm.<domain>       → http://127.0.0.1:8760    # server 调用，挂 Access（见第 2 节）
labs-console.<domain>  → http://127.0.0.1:6080     # 浏览器直连，不挂 Access（见第 2 节，端口按实际启动参数改）
labs-agent.<domain>    → http://127.0.0.1:8770     # 先占位保留 hostname，Access 应用可以先不建
```

`8765` 不写 ingress 规则、不建 hostname。`labs-console.<domain>` 虽然走的是 WebSocket
（`wss://`），但 Cloudflare Tunnel 的 ingress 规则跟 HTTP hostname 路由写法一样——`cloudflared`
会透明处理 WebSocket upgrade，本地服务地址照样写 `http://`，不要写成 `ws://`（cloudflared 不认）。

## 1a. `websockify`（新增，浏览器直连的 RDP 转发层）

**这是这次改动新增的第三个 Labs 主机服务，之前的清单里没有它。**

`websockify` 负责把浏览器的 WebSocket 连接转发成到 VM 内网 RDP 端口的原始 TCP 字节流，跟具体
协议无关。用它的 `TokenFile` 插件模式，一个进程服务所有学员，不用给每台 VM 起一个转发进程：

```bash
pip install websockify   # 或用发行版包管理器；先用 websockify --help 核对下面两个 flag 的真实名字，
                          # 不同发行版打包的版本可能有出入，这一步在写 systemd unit 之前必须做
mkdir -p /etc/aivirteach-labs/console-tokens
websockify --token-plugin=TokenFile --token-source=/etc/aivirteach-labs/console-tokens 6080
```

- Token 目录 `/etc/aivirteach-labs/console-tokens` 必须跟 `aivirteach-labs/libvirt/config/defaults.env`
  里的 `CONSOLE_TOKEN_DIR` 一致（当前默认值就是这个路径）——`vm-control.sh register-console-token`
  子命令写文件到这里，`websockify` 从这里读。
- 目录里每个文件名是一个 token（`generateOpaqueToken()` 生成的 base64url 字符串），内容是
  `<token>: <VM内网ip>:<rdp端口>`——这个格式和目录由 `register-console-token` 子命令负责写、
  负责清理过期文件（每次注册前清一次，见 `aivirteach-labs/libvirt/scripts/vm-control.sh`），
  不需要单独配 cron。
- 生产环境把上面手工起的命令改成 `systemd` unit（开机自启、崩溃自动重启），监听端口跟 Tunnel
  ingress 规则里的端口对应（示例用 `6080`，可以改成别的，只要跟 ingress 规则一致）。

**这一路径没有已知先例整合验证过**（`ironrdp-web` 单独有生产案例，`websockify` 单独有生产案例，
但"两者接在一起转发真实 xrdp"没查到先例）——见下面第 5a 节"连通性验证"，**必须先跑通这一步再把
Tunnel 路由接成正式的**，否则出问题很难判断是 Tunnel 配置错了还是这条集成路径本身有问题。

## 2. Cloudflare Access Application + Service Token

**`labs-console.<domain>` 不建 Access Application——这是刻意的，不是漏配。** `labs-vm.<domain>`
只被 server（一段后端代码）调用，可以带 `CF-Access-Client-Id`/`CF-Access-Client-Secret` 这种
机器对机器凭据。`labs-console.<domain>` 是**学员浏览器里的 WASM 组件直接连的**，浏览器没有办法
（也不应该）持有这两个 Service Token 值——塞进前端代码等于把凭据发给每个访问页面的人。这条连接
唯一的保护是 `register-console-token` 生成的一次性路由 token（32 字节随机、5 分钟过期、只能告诉
`websockify` 转发到哪台 VM，不做身份验证）——身份验证已经在浏览器打这个请求之前，由 `/workspace`
页面现有的 JWT 会话完成了。如果给 `labs-console.<domain>` 建了 Access Application，学员点击"启动
远程桌面"会直接被 Cloudflare 拦截（浏览器没有 Access 登录态），这个功能会整个打不开。

只给 `labs-vm.<domain>` 建一个 Access Application（`labs-agent` 等 server 端实现了诊断功能再建）：

1. Cloudflare Zero Trust 后台 → Access → Applications → Add an application → Self-hosted
2. Domain 填 `labs-vm.<domain>`
3. Policy 用 **Service Auth**（不是给人登录用的，是给 server 的机器对机器调用），生成一对
   **Service Token**（Client ID + Client Secret）
4. 这对值就是 server 端要配的 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`——server 请求时会带在
   `CF-Access-Client-Id` / `CF-Access-Client-Secret` 请求头里（`labs-client.ts` 已经这么实现了），
   未授权请求在到达 FastAPI 之前就被 Cloudflare 边缘挡掉，是现有 `AIVIRTEACH_API_TOKEN` 之外的第一层防线

## 3. 现有静态 token 不动

`AIVIRTEACH_API_TOKEN`（Labs 主机 `config/api.env` 里已经配过的那个）保持原样，作为 Cloudflare
Access 之后的第二层防线。**这个值必须和 server 端 Vercel 项目里配的 `AIVIRTEACH_API_TOKEN` 完全一致**
——两边变量名一样，是同一个值抄两份，不需要改代码或轮换。

## 4. 边缘层限流（建议）

建 VM（`POST /v1/vms`）和删 VM 都是破坏性/资源密集操作，建议在 `labs-vm.<domain>` 上加一条 Cloudflare
WAF / Rate Limiting 规则，比如按 IP（也就是 Vercel 出口）限制 `POST /v1/vms` 的频率，防止误触发或被扫描。

## 5. 配置完成后怎么验证

在 Labs 主机本地先确认服务本身活着：

```bash
curl http://127.0.0.1:8760/health
```

再从**外部**（不是 Labs 主机上）验证 Tunnel + Access 是否生效，两层缺一都应该被挡：

```bash
# 不带 Access Service Token —— 预期被 Cloudflare Access 拦截（不会到达 FastAPI）
curl -i https://labs-vm.<domain>/health

# 带上 Access Service Token + 静态 API token —— 预期拿到 200 和 server 端一致的响应
curl -i https://labs-vm.<domain>/health \
  -H "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"

curl -i https://labs-vm.<domain>/v1/vms/nonexistent/status \
  -H "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>" \
  -H "Authorization: Bearer <AIVIRTEACH_API_TOKEN>"
```

Labs 侧这一层通了之后，接第 6 节把 server / client 也接起来，走一遍完整的端到端验证。

## 5a. Console/RDP 连通性验证（第一次接这条路径必须做）

**这是"`ironrdp-web` 通过 `websockify` 转发连真实 xrdp"这条集成路径的第一次真实验证**——`aivirteach-server`
（PR #9）和 `aivirteach-client` 的代码都已经写好、测试过（单元测试/mock 层面），但没有人在真实
Labs VM 上跑通过，因为写代码的人（agent）没有 Labs 主机的访问权限。下面这步必须由能碰到实际
Labs 主机的同事跑一遍，是这次能不能上线的唯一 gate。

**跟老版本设计文档里的"spike"计划不同：不需要再手搭一个临时 HTML 测试页**——`ConsoleViewer`
组件（`aivirteach-client/app/workspace/console-viewer.tsx`）和 server 端接口都已经是真代码，直接
拿真实的 `/workspace` 页面测就行：

1. **准备一台测试 VM**：用现有的 `POST /v1/vms` 建一台，或者复用已有的测试 VM。记下它的 `lab_id`。
2. **确认 1a 节的 `websockify` 在 Labs 主机上跑起来**（先手工前台跑，不急着配 `systemd`），确认
   `/etc/aivirteach-labs/console-tokens` 目录存在。
3. **本地起 server**，配置好 `LABS_VM_BASE_URL`/`AIVIRTEACH_API_TOKEN`/`CF_ACCESS_CLIENT_ID`/
   `CF_ACCESS_CLIENT_SECRET`（打通 Labs 主 API）+ `LABS_CONSOLE_WS_URL`（先指向一个能从本地连到
   Labs 主机 `websockify` 端口的地址——比如临时 SSH 端口转发 `ssh -L 6080:127.0.0.1:6080 <labs主机>`
   之后填 `LABS_CONSOLE_WS_URL=ws://127.0.0.1:6080`，本地测试用 `ws://` 不用 `wss://`，正式环境
   才需要过 Cloudflare Tunnel 的 TLS）。
4. **本地起 `aivirteach-client`**（`feat/workspace-vm-orchestration` 分支），登录 → 进
   `/workspace` → 等 VM 状态变 `RUNNING` → 点击"Start remote desktop"。
5. **打开浏览器 DevTools，检查**：
   - Network 面板：`POST /workspaces/:id/console-session` 拿到 200，返回体里有 `wsUrl`/
     `rdpUsername`/`rdpPassword`/`expiresAt`
   - Network 面板：紧接着有一个 WebSocket 连接（能看到 `101 Switching Protocols`），地址是上一步
     返回的 `wsUrl`
   - **RDP 握手完成**：`<iron-remote-desktop>` 内部的 `<canvas>` 渲染出测试 VM 的真实桌面画面（不是
     空白/一直转圈）
   - 能用鼠标点击、键盘输入，VM 里有对应反应

**如果 WebSocket 连接本身失败**（拿不到 101，或者连上就立刻断开）：这是 `websockify`/Tunnel/token
这一层的问题，跟 IronRDP 无关。按顺序排查：`websockify` 是否真的在监听、`register-console-token`
是否真的写了 token 文件、`ws://127.0.0.1:<port>` 直连（跳过 Tunnel）能不能通。

**如果 WebSocket 连上了，但 RDP 画面一直不出现或报错**：优先怀疑
`aivirteach-client/app/workspace/console-viewer.tsx` 里的两个占位值，这是实现阶段没有真实环境
可验证、标记为"留给硬件验证"的已知开放项：

- `RDP_DESTINATION_PLACEHOLDER = "console"`（`withDestination(...)`）——Devolutions 官方例子里这个
  参数是给他们自家 Devolutions Gateway 产品用的真实 `host:port`，我们这套架构用 `websockify` 的
  `TokenFile` 纯靠 token 路由，浏览器根本拿不到 VM 真实内网地址，所以填了一个占位字符串。如果
  报错信息提到 destination/目标地址，说明 IronRDP 的 RDP 握手层确实会用这个值做校验，需要想办法
  让浏览器拿到真实 `host:port`（比如 server 把它也放进 `console-session` 响应里）——这会是一次
  代码改动，不只是改配置。
- `RDP_AUTH_TOKEN_PLACEHOLDER = "unused"`（`withAuthToken(...)`）——同样是 Devolutions Gateway
  的 JWT 鉴权参数，我们的 `websockify` 隧道不需要它。如果报错信息提到 auth token/认证失败，同理。

如果两个占位值都不是问题根源，且 RDP 握手确实完成但画面渲染有问题，检查
`console-viewer.tsx` 里 `scale`/`verbose`/`flexcenter` 这几个 attribute 的取值（当前分别是
`"fit"`/`"false"`/`"true"`，已经根据实际安装的 npm 包版本核对过存在，不是猜的）。

**验证结果请回填到这份文档**（改这个文件、提交、或者至少在 PR 里留言）：哪一步失败在哪、报什么
错、两个占位值是否需要改成真实值——这样下一个碰这段代码的人不用重新踩一遍。

## 6. 端到端联调 Checklist（Labs → Server → Client）

> 三块分别由不同人跑：Labs 那部分需要能碰到实际主机的人做；Server/Client 这两块谁跑都行，
> 但顺序不能反——client 要连的 server 必须先能打通 Labs，否则点"启动"只会卡在建 VM 这一步。

### Labs（前置，做完第 1-5 节才能进这里）

- [ ] `curl http://127.0.0.1:8760/health`（Labs 主机本地）拿到 200
- [ ] `curl https://labs-vm.<domain>/health`（外部，不带 token）被 Cloudflare Access 拦截，**不是** 200
- [ ] 带上 Service Token + `AIVIRTEACH_API_TOKEN` 的 `curl`（见第 5 节两条命令）拿到 200

### Server（部署到 Vercel）

> 建议先用 PR #8 的 Preview Deployment 测，不要先合并到 main——出问题改完直接推同一分支重跑，
> 不污染 main。

- [ ] Vercel 项目 Preview 环境加上本文档第 2、3 节生成的 4 个变量：`LABS_VM_BASE_URL`、
      `AIVIRTEACH_API_TOKEN`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`
- [ ] 加上第 1a 节生效后的 `LABS_CONSOLE_WS_URL`（指向 `websockify` 的 `wss://labs-console.<domain>`
      地址——注意这个不需要、也不能带 Access 相关的值，见第 2 节）
- [ ] 确认 `DATABASE_URL`、`JWT_SECRET` 等既有变量在 Preview 环境也生效（不是只配了 Production）
- [ ] 触发一次 Preview 部署，记下分配到的 URL

### Client（本地跑，指向上面的 Preview URL）

- [ ] `aivirteach-client` 切到 PR #3 分支（`feat/workspace-vm-orchestration`）
- [ ] `.env.local` 设置：
  ```
  NEXT_PUBLIC_BACKEND_MODE=remote
  NEXT_PUBLIC_REMOTE_API_BASE_URL=https://<上面记下的 Preview URL>/api/v1
  ```
- [ ] `npm run dev` 起本地 client
- [ ] 登录 → 选一门配了 workspace 的课程 → 进 `/workspace` → 点击启动
- [ ] Network 面板确认建 VM 的 POST 请求成功（说明 server → Cloudflare Access → Labs 这条链路通了）
- [ ] 页面状态自动变成 `RUNNING`（WebSocket 推送，不用手动刷新）
- [ ] （可选）故意在 Labs 侧制造失败（比如临时改错 `AIVIRTEACH_API_TOKEN`），确认页面能展示 `ERROR`
      状态而不是卡死转圈
- [ ] 点击"Start remote desktop"：走一遍第 5a 节的连通性验证（真实 xrdp 画面 + 键鼠可用）
- [ ] 故意断开/清空 `LABS_CONSOLE_WS_URL`，确认点击按钮时展示"远程桌面服务未配置"一类的明确错误，
      而不是卡死转圈或者裸的 500

全部打勾后 PR #8 / PR #9 / PR #3 才可以合并——第 5a 节是 design spec 里"必须先跑通 spike 才能上线"
这条要求最终落地验证的地方。

## 明确不在这份清单范围内

- Server（`aivirteach-server`）自己的 Vercel 项目搭建（build 设置、自定义域名等）——这是另一件事，
  第 6 节只覆盖这次要新加的 5 个环境变量
- `WorkspaceGateway` 的 WebSocket 端点（`/api/v1/workspaces/socket`）走 server 自己的公网地址，
  不经过 Labs Tunnel，不需要单独配置
- `labs-agent.<domain>` 仍然只是预留 hostname——诊断/Console-agent 功能单独立项，这次不需要为它建
  Access Application 或起对应的 Labs 服务
- `console-viewer.tsx` 里 `RDP_DESTINATION_PLACEHOLDER`/`RDP_AUTH_TOKEN_PLACEHOLDER` 两个占位值
  如果第 5a 节验证后发现需要改成真实值，这是一次前端代码改动（可能还需要 server 端
  `console-session` 接口多返回一个字段），不是这份运维清单能单独解决的——发现问题后回去找写这段
  代码的人，不要在这份文档里自行决定改什么值
