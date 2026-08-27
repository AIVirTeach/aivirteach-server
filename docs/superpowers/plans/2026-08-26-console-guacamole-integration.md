# Console/RDP 远程桌面接入（改接 Guacamole）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `aivirteach-server`/`aivirteach-client` 里"学员点一下按钮，浏览器里看到、操作 Labs VM 真实桌面"这条链路，从已实现的 IronRDP+websockify 换成对接 Labs 同事已经部署的 Apache Guacamole（`vm_agent_local` 分支）。

**Architecture:** server 新增 `LabsClient.createBrowserSession()` 转发 Labs 的 `POST /v1/vms/{lab_id}/browser-sessions`（拿到一个加密的 Guacamole JSON-auth 票据），`WorkspaceController`/`WorkspaceService` 原样透传给浏览器；浏览器用 `guacamole-common-js` 把票据交给 `WorkspaceController` 新增的 `POST :enrollmentId/console-session/token` 端点，由 server 转发 Guacamole 的 `POST /api/tokens` 换回真实 `authToken`（server 对 server，不受浏览器 CORS 限制），再用这个 `authToken` 直接跨域开 WebSocket tunnel 渲染桌面。**为什么要 server 转发这一步、WebSocket 为什么不用同源反代，详见下面「架构变更记录」和[设计文档](../specs/2026-08-26-console-guacamole-integration-design.md)。**

**Tech Stack:** NestJS/Prisma（server）、Next.js (RSC, `vinext`/Cloudflare Workers) + `guacamole-common-js` + `@types/guacamole-common-js`（client）。

## Global Constraints

- **不碰 `aivirteach-labs` 仓库**——`vm_agent_local` 分支（Apache Guacamole 部署）是同事的工作，这份计划只覆盖 `aivirteach-server`/`aivirteach-client` 怎么对接它暴露出来的接口。
- **不引入 Tauri**——`aivirteach-client` 的 `vm_vlient` 分支是另一件未完成的事，这次不跟进。
- **不改动 `WorkspaceGateway`**（`src/workspace/workspace.gateway.ts`）——它是工作区创建状态推送通道（`CREATING`/`RUNNING`/`ERROR`，`/api/v1/workspaces/socket`），跟这次改的 RDP/console 传输无关，之前 brainstorming 一度错误地计划删除它，已经在设计文档里订正。
- **RDP 密码不经过 `aivirteach-server`**——Labs 把密码直接加密进 Guacamole 票据（`data` 字段），服务端只转发这个不透明字符串，不解密、不落库、不记日志。
- **服务端不做阻塞轮询**——`console-session` 接口每次被调用只转发 Labs 当前返回的 `state`，轮询责任在客户端。
- **不新增 Prisma model**——票据 `data`/`expiresAt` 不落库，每次现取现转发。
- **审计只记有意义的结果**——`state === "ready"`（真正建立了会话）或者 Labs 调用本身失败时才写 `AuditService.record()`；中间的 `"starting"`/`"unavailable"` 轮询响应不写审计，避免客户端每 2-3 秒轮询一次导致审计表被灌满。
- **两个仓库分支前提**：
  - `aivirteach-server`：当前仓库，当前分支 `docs/console-rdp-access-spec`（PR #9），原地继续改，不切新分支。
  - `aivirteach-client`：`/Users/owenlee/Desktop/2025年/项目/aivirteach-client`，分支 `feat/workspace-vm-orchestration`（PR #3），原地继续改，不切新分支。

---

## 架构变更记录（2026-08-27）

Task 1-6 最初是按"浏览器跨域直连 Labs 的 Guacamole 域名 + CORS"设计并实现的（`guacamoleBaseUrl` 是绝对 URL，`console-viewer.tsx` 直接 `fetch` 跨源地址）。这个设计在 `aivirteach-labs` PR #5（给 Guacamole 加 Nginx CORS 代理）验证阶段被推翻，原因和后续经过：

1. **同事 `vm_agent_local` 分支的权威架构不是跨域直连，是同源反代**：README 明确写了"当前架构决定"——浏览器只通过同源的 `/guacamole/` 路径访问 Guacamole，前面必须有一层边缘路由（Labs 的网关/Cloudflare Tunnel）做同源反代，不需要也不应该给 Guacamole 加 CORS。据此关闭了 `aivirteach-labs` PR #5，把 server（`env.ts`/`workspace.service.ts`）和 client（`console-viewer.tsx`/`api.ts`/`page.tsx`）的契约都改成同源相对路径，去掉了 `guacamoleBaseUrl`/`LABS_GUACAMOLE_BASE_URL` 这些绝对 URL 字段。
2. **本地曾经尝试用 `next.config.ts` 的 `rewrites()` 在本地开发环境模拟这层同源反代，已被证明不可行并移除**：实测 `rewrites()` 能正常代理 `POST /guacamole/api/tokens`（HTTP），但代理不了 `/guacamole/websocket-tunnel` 的 WebSocket upgrade（连接立刻 `1006` 异常关闭，直连 Guacamole 则正常）。这跟 Vercel 生产环境下 Next.js rewrites 代理 WebSocket 不可靠的已知问题一致。**结论：同源反代这层不能由 `aivirteach-client` 自己的 Next.js/Vercel 配置实现，必须是部署层独立的边缘路由（nginx/Caddy/Cloudflare Tunnel ingress 之类，真正支持 WS upgrade 的反代）**，目前两边仓库都还没有这层的实现代码。
3. **核心链路已经用同事提供的真实 Labs 环境（真实 `AIVIRTEACH_SESSION_TOKEN` + 真实 `lab-001` VM + trycloudflare quick tunnel）端到端验证过一遍，全部走通**：`POST /v1/vms/lab-001/browser-sessions`（拉起 VM、拿到真实加密票据）→ 真实 Guacamole `/guacamole/api/tokens` 换 `authToken` → 真实 WebSocket tunnel 收到 Guacamole 协议握手数据。这次是跨域直连 tunnel URL 测的（不经过任何同源代理），所以验证的是"票据格式 + Guacamole 握手协议 + WS tunnel 机制"这部分，不是"同源路由"那部分——两者是独立问题。

4. **同源边缘路由这条思路被放弃了，改成 server 转发 `/api/tokens` 这一步**：本项目目前只是 demo/MVP，不需要为了"浏览器全程不知道 Guacamole 真实地址"这个属性去搭一层生产级的边缘路由——那本来就是同源反代唯一换来的东西，而且上面第 2 点已经证明这层反代在 `aivirteach-client` 自己的部署栈里做不了。CORS 卡的其实只有 `POST /guacamole/api/tokens` 这一次 HTTP 请求（Guacamole 默认不带 `Access-Control-Allow-Origin`）——WebSocket tunnel 本身不受浏览器 CORS 限制，直连不需要任何一方额外配合。于是把这一次 `fetch` 改成由 `aivirteach-server` 转发：浏览器 `POST` 给自己的 server（同源，不受 CORS 影响）→ server 用新增的 `LabsClient.exchangeGuacamoleToken()` 对 Guacamole 发起 server-to-server 请求（不是浏览器发起，不受 CORS 限制）→ 拿到 `authToken` 后连同 server 算好的 `websocketUrl` 一起返回给浏览器 → 浏览器直接跨域开 WebSocket。代价很明确：浏览器仍然会在开 WS 那一步看到 Guacamole 的真实地址（只是拿 `authToken` 这步不再直连），demo 阶段可以接受；生产环境如果需要隐藏真实地址，再单独评估要不要上同源反代。这个方案不需要同事在 `aivirteach-labs` 那边做任何改动（不用重开 PR #5，也不用搭边缘路由），已经实现并测试通过（`LabsClient.exchangeGuacamoleToken`/`WorkspaceService.exchangeConsoleToken`/`WorkspaceController` 新端点 + client `ConsoleViewer`/`api.ts` 改造）。

**当前唯一未解决的技术缺口**：`LABS_GUACAMOLE_BASE_URL`（server 端用来转发 `/api/tokens` 的 Guacamole 真实地址）用同事当前的 `trycloudflare.com` quick tunnel 地址够不够稳定——这类地址每次 `cloudflared` 重启都会变，写进 Vercel 环境变量后一旦同事那边重启就会失效。demo 阶段这条可以先不管（有问题再手动更新），但值得跟同事确认一下这个地址大概多久变一次。

---

### Task 1: Spike — 验证 `guacamole-common-js` 1.5.0 客户端库对 Guacamole 1.6.0 服务端真的能连上

**这是验证性任务，不产出会合并进 `aivirteach-client`/`aivirteach-server` 的代码**，纯粹是为了在写周边胶水代码之前，先确认三件没有先例验证过的事：(a) npm 上 `guacamole-common-js` 最新只到 1.5.0，Labs 的 Docker Compose 部署的是 1.6.0，这两个版本能不能正常握手；(b) 这个包的 ESM 构建只有 `export default Guacamole`，但 `@types/guacamole-common-js` 的类型声明是按 `export as namespace Guacamole` + 具名导出建模的，实际 `import` 语句要写成什么样子 TypeScript 和 Vite 才都认；(c) `Guacamole.Client.connect(data)` 里 `data` 参数的确切格式（`token=...&GUAC_DATA_SOURCE=json&GUAC_ID=...&GUAC_TYPE=c` 这类 key，具体名字要实测，不能只凭旧版本文档假设）。如果这一步走不通，Task 2 开始的所有任务都要重新评估，所以必须排第一个。

**环境**：全程本地 Docker，不依赖 Labs 主机、不需要 SSH 访问权限。

- [x] **Step 1：本地起一份跟 Labs 同版本的 Guacamole（1.6.0）+ 一个测试 RDP 目标**

在临时目录（不是 `aivirteach-server`/`aivirteach-client` 仓库里）新建 `docker-compose.yml`：

```yaml
services:
  guacd:
    image: guacamole/guacd:1.6.0
  guacamole:
    image: guacamole/guacamole:1.6.0
    depends_on: [guacd]
    environment:
      GUACD_HOSTNAME: guacd
      GUACD_PORT: "4822"
      JSON_ENABLED: "true"
      JSON_SECRET_KEY: "REPLACE_WITH_32_HEX_CHARS"
    ports:
      - "127.0.0.1:8080:8080"
  rdp-target:
    image: danielguerra/ubuntu-xrdp:latest
    ports:
      - "127.0.0.1:3389:3389"
```

```bash
openssl rand -hex 16   # 生成 32 位十六进制密钥，替换上面的 JSON_SECRET_KEY
docker compose up -d
docker compose logs -f guacamole   # 等到看见 Tomcat 启动完成、没有报错
```

验证 Guacamole 起来了：浏览器打开 `http://localhost:8080/guacamole/`，能看到登录页（不用登录，后面走 JSON auth）。

- [x] **Step 2：写一个 Node 脚本，按 Labs `_encrypt_guacamole_payload` 同样的算法构造票据**

这个算法来自 `aivirteach-labs` 的 `vm_agent_local` 分支 `vm-manager/service.py`（只读参考，不修改那个仓库）：HMAC-SHA256 签名 + 明文拼接，PKCS7 padding，AES-128-CBC **零 IV** 加密，base64 编码。

```javascript
// ticket.mjs —— 临时脚本，不进任何仓库
import crypto from "node:crypto";

const SECRET_HEX = "REPLACE_WITH_SAME_32_HEX_CHARS_AS_JSON_SECRET_KEY";
const key = Buffer.from(SECRET_HEX, "hex");

const payload = {
  username: "spike-user",
  expires: Date.now() + 5 * 60 * 1000,
  connections: {
    "spike-connection": {
      protocol: "rdp",
      parameters: {
        hostname: "rdp-target", // docker compose 网络内部 DNS 名
        port: "3389",
        username: "ubuntu",
        password: "ubuntu", // danielguerra/ubuntu-xrdp 镜像的默认账号
        security: "any",
        "ignore-cert": "true",
        "resize-method": "display-update",
        "enable-wallpaper": "true",
      },
    },
  },
};

const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
const hmac = crypto.createHmac("sha256", key).update(plaintext).digest();
const signed = Buffer.concat([hmac, plaintext]);
const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
const encrypted = Buffer.concat([cipher.update(signed), cipher.final()]);
console.log(encrypted.toString("base64"));
```

```bash
node ticket.mjs > ticket.txt
cat ticket.txt   # 这就是等价于 Labs browser-sessions 接口返回的 data 字段
```

用 curl 验证这个票据 Guacamole 真的认：

```bash
curl -s -X POST http://localhost:8080/guacamole/api/tokens \
  --data-urlencode "data@ticket.txt" | head -c 500
```

期待：返回 JSON，里面有 `authToken` 字段（形如 `{"authToken":"...","username":"spike-user",...}`）。如果返回 400/401，先检查 `JSON_SECRET_KEY`（Guacamole 侧）跟脚本里 `SECRET_HEX` 是不是完全一致的 32 位十六进制字符串——这是最常见的失败原因。

- [x] **Step 3：起一个最小 Vite 项目，验证 `guacamole-common-js` 的正确 import 方式**

```bash
npm create vite@latest guac-spike -- --template vanilla-ts
cd guac-spike
npm install
npm install guacamole-common-js@1.5.0
npm install --save-dev @types/guacamole-common-js@1.5.5
```

把 `src/main.ts` 换成：

```typescript
import * as Guacamole from "guacamole-common-js";

console.log("Guacamole namespace keys:", Object.keys(Guacamole));
console.log("Has Client:", typeof Guacamole.Client);
console.log("Has WebSocketTunnel:", typeof Guacamole.WebSocketTunnel);
```

```bash
npm run dev
```

浏览器打开开发服务器地址，看控制台输出：

- 如果 `Guacamole.Client`/`Guacamole.WebSocketTunnel` 都是 `"function"`：`import * as Guacamole from "guacamole-common-js"` 这个写法可用，记下来给 Task 6 用。
- 如果 `Object.keys(Guacamole)` 只有一个 `default` 键（说明打包器把 ESM 的 `export default` 包成了 `{ default: Guacamole }`）：改成 `import Guacamole from "guacamole-common-js";`（默认导入）再试一次；如果这样 TypeScript 报类型错误（因为 `@types` 包按具名导出声明，没有 default 导出），需要在 `tsconfig.json` 里加 `"esModuleInterop": true, "allowSyntheticDefaultImports": true`（检查 `aivirteach-client` 的 `tsconfig.json` 现在有没有开——大概率已经开了，Next.js 项目默认模板通常打开这两个选项）。

把最终确认可行的 import 写法记下来，供 Task 6 使用。

- [x] **Step 4：完整走一遍"票据 → authToken → WebSocket tunnel → 看到桌面"，且必须用浏览器自己的 `fetch()` 换 `authToken`（不能手工粘贴）**

**为什么不能像 Step 2 那样用 curl 拿 `authToken` 再手工粘贴过来**：Task 5 的 `console-viewer.tsx` 在真实生产环境里是浏览器 JS 直接 `fetch()` 跨源调用 `${guacamoleBaseUrl}api/tokens`（`aivirteach-client` 的域名 vs. `labs-console.<domain>`，两个不同源）。curl 没有浏览器的同源策略，验证不出 Guacamole 的 Tomcat 部署到底有没有对这个跨源 `fetch()` 返回 `Access-Control-Allow-Origin` 响应头——Apache Guacamole 默认不带 CORS 响应头，如果生产环境也没加，`console-viewer.tsx` 的 `fetch()` 会直接报 CORS 错误，界面上只会看到一个含糊的网络错误。这一步必须让浏览器自己发这个请求，才能在合并任何周边代码之前发现这个问题。Vite dev server（默认 `http://localhost:5173`）和 Guacamole（`http://localhost:8080`）本来就是不同 origin，足够模拟这个场景。

在 `src/main.ts` 里接着刚才验证过的 import 写法，写：

```typescript
const ticketData = /* 手工从 Step 2 生成的 ticket.txt 内容粘贴进来（是 data 字段本身，不是 authToken） */ "PASTE_HERE";

async function connect() {
  const tokenResponse = await fetch("http://localhost:8080/guacamole/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: ticketData }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`api/tokens 换 authToken 失败（${tokenResponse.status}）`);
  }
  const tokenBody = (await tokenResponse.json()) as {
    authToken: string;
    connections?: Record<string, { identifier?: string }>;
  };
  console.log("token response body:", tokenBody); // 用来核对 connections 字段的实际结构/key

  const tunnel = new Guacamole.WebSocketTunnel("ws://localhost:8080/guacamole/websocket-tunnel");
  const client = new Guacamole.Client(tunnel);

  const display = client.getDisplay();
  document.body.appendChild(display.getElement());

  client.onerror = (status) => console.error("Guacamole client error:", status);
  tunnel.onerror = (status) => console.error("Tunnel error:", status);

  const connectionId = /* 核对上面 console.log 出的 tokenBody.connections 实际结构后填 */ "PASTE_HERE";
  const params = new URLSearchParams({
    token: tokenBody.authToken,
    GUAC_DATA_SOURCE: "json",
    GUAC_ID: connectionId,
    GUAC_TYPE: "c",
    GUAC_WIDTH: "1024",
    GUAC_HEIGHT: "768",
  });
  client.connect(params.toString());
}

connect().catch((error) => console.error("connect() failed:", error));
```

浏览器打开页面，检查：

- DevTools Network 面板能看到 `POST http://localhost:8080/guacamole/api/tokens` 请求成功（状态 200，不是被 CORS 拦截的 `(failed) net::ERR_FAILED`）——DevTools Console 里如果出现 `has been blocked by CORS policy` 字样，这一步直接判定失败，进 Step 5 的 no-go 分支。
- DevTools Network 面板能看到到 `/guacamole/websocket-tunnel` 的 WebSocket 连接，状态 101 Switching Protocols。
- 页面上出现 `rdp-target` 容器里 xrdp 桌面的真实画面（不是空白/错误）。
- `client.onerror`/`tunnel.onerror` 没有触发。

- [x] **Step 5：记录发现，做 go/no-go 判断**

在这次会话里（不需要建文件）跟人类伙伴同步：

- 最终确认可行的 `import` 写法（供 Task 6 的 `console-viewer.tsx` 用）。
- `client.connect()` 的 `data` 参数里，实测哪些 key 是必须的（`GUAC_DATA_SOURCE`/`GUAC_ID`/`GUAC_TYPE` 具体取值，`connectionId` 到底等不等于 Labs 那边票据里 `connections` 字典的 key，即示例里的 `lab_id`）。
- 1.5.0 客户端连 1.6.0 服务端是否有任何协议不兼容的警告/报错（即使最终能连上，也要记录控制台里出现过的任何 warning）。
- **Step 4 的 `fetch('/api/tokens')` 有没有被 CORS 拦截。** 如果本地 Docker Compose 部署的 Guacamole 默认就不带 `Access-Control-Allow-Origin`，几乎可以确定 Labs 主机上同样的镜像/部署方式也不会带——这种情况下**不能**指望生产环境"可能配了反代加上了 CORS 头"就蒙混过关，必须明确 no-go，回去跟人类伙伴讨论是否要在 `aivirteach-server` 里加一个转发 `/api/tokens` 请求的代理端点（浏览器改成调我们自己的服务端，服务端再服务端对服务端地调用 Guacamole，没有浏览器同源限制），这会实质性改变 Task 4/Task 5 的设计，不是小修小补。
- 如果哪一步失败：记录清楚失败在哪、报什么错，**STOP**，回去跟人类伙伴讨论要不要调整设计，不要跳过验证直接往下走。

**只有这一步验证通过，才能继续 Task 2。**

```bash
docker compose down -v   # 清理本地测试环境，这些容器不需要保留
```

---

### Task 2: Server — `env.ts` 环境变量改动

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces：`Env.AIVIRTEACH_SESSION_TOKEN: string | undefined`、`Env.LABS_GUACAMOLE_BASE_URL: string | undefined`（替代原来的 `LABS_CONSOLE_WS_URL`）。Task 3 的 `LabsClient.createBrowserSession()` 用前者，Task 4 的 `WorkspaceService.createConsoleSession()` 用后者。

- [x] **Step 1：改测试——把 `LABS_CONSOLE_WS_URL` 的两个用例改名成 `LABS_GUACAMOLE_BASE_URL`**

在 `src/config/env.spec.ts` 里，找到这两个用例：

```typescript
  it('LABS_CONSOLE_WS_URL 未配置时为 undefined，不影响其余必填校验', () => {
    const env = loadEnv(validSource);
    expect(env.LABS_CONSOLE_WS_URL).toBeUndefined();
  });

  it('LABS_CONSOLE_WS_URL 配置了但不是合法 URL 时抛错', () => {
    expect(() =>
      loadEnv({ ...validSource, LABS_CONSOLE_WS_URL: 'not-a-url' }),
    ).toThrow(/LABS_CONSOLE_WS_URL/);
  });
```

替换成：

```typescript
  it('LABS_GUACAMOLE_BASE_URL 未配置时为 undefined，不影响其余必填校验', () => {
    const env = loadEnv(validSource);
    expect(env.LABS_GUACAMOLE_BASE_URL).toBeUndefined();
  });

  it('LABS_GUACAMOLE_BASE_URL 配置了但不是合法 URL 时抛错', () => {
    expect(() =>
      loadEnv({ ...validSource, LABS_GUACAMOLE_BASE_URL: 'not-a-url' }),
    ).toThrow(/LABS_GUACAMOLE_BASE_URL/);
  });
```

再加一个新用例（校验结尾斜杠——见下面 Step 3 的说明，`console-viewer.tsx` 直接用字符串拼接 `${guacamoleBaseUrl}api/tokens`，不带结尾斜杠会拼出错误的 URL）：

```typescript
  it('LABS_GUACAMOLE_BASE_URL 配置了但不以 / 结尾时抛错', () => {
    expect(() =>
      loadEnv({ ...validSource, LABS_GUACAMOLE_BASE_URL: 'https://labs-console.test' }),
    ).toThrow(/LABS_GUACAMOLE_BASE_URL/);
  });
```

- [x] **Step 2：跑测试确认失败**

```bash
npm test -- src/config/env.spec.ts
```
Expected: 这三个用例 FAIL（`LABS_GUACAMOLE_BASE_URL` 字段还不存在于 schema 里，`loadEnv(validSource)` 返回的对象里没有这个 key，`toBeUndefined()` 断言本身会通过，但后两个用例期待抛错、实际不会抛——因为未知字段会被 Zod 直接忽略，不校验）。

- [x] **Step 3：改 `EnvSchema`**

在 `src/config/env.ts` 里，把：

```typescript
  CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),
  // websockify 对外的 wss:// 基础地址，给浏览器建 RDP WebSocket 连接用；
  // 跟 LABS_VM_BASE_URL（VM 生命周期 HTTP API）是两个不同用途的地址。
  LABS_CONSOLE_WS_URL: z.url().optional(),
```

改成：

```typescript
  // Labs 的 POST /v1/vms/{lab_id}/browser-sessions 用这个鉴权，是跟 AIVIRTEACH_API_TOKEN
  // 不同的静态密钥；两者是否配置了且不相同的校验在 LabsClient.createBrowserSession() 里做，
  // 不在这里（延续本文件其余 Labs 变量"缺配置不让整个 server 起不来"的约定）。
  AIVIRTEACH_SESSION_TOKEN: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),
  // Guacamole webapp 的 https:// 根路径，给浏览器建 Guacamole 会话用；
  // 跟 LABS_VM_BASE_URL（VM 生命周期 HTTP API）是两个不同用途的地址。
  // 必须以 / 结尾——client 侧 `console-viewer.tsx` 直接字符串拼接
  // `${guacamoleBaseUrl}api/tokens`/`${wsBase}websocket-tunnel`，不在这里强制的话，
  // 少了结尾斜杠会拼出一个语法正确但指向错误主机的 URL，报错会很难查。
  LABS_GUACAMOLE_BASE_URL: z
    .url()
    .refine((value) => value.endsWith('/'), 'LABS_GUACAMOLE_BASE_URL 必须以 / 结尾（Guacamole webapp 根路径）')
    .optional(),
```

- [x] **Step 4：跑测试确认通过**

```bash
npm test -- src/config/env.spec.ts
```
Expected: PASS。

- [x] **Step 5：`.env.example` 更新**

把：

```bash
# Labs 主机上 websockify 的 wss:// 地址（Console/RDP 浏览器直连用）
LABS_CONSOLE_WS_URL=
```

改成：

```bash
# Labs 的 POST /v1/vms/{lab_id}/browser-sessions 鉴权用，是跟 AIVIRTEACH_API_TOKEN 不同的静态密钥
AIVIRTEACH_SESSION_TOKEN=

# Labs 主机上 Guacamole webapp 的 https:// 根路径（Console/RDP 浏览器直连用）
# 必须以 / 结尾，例如 https://labs-console.example.com/guacamole/
LABS_GUACAMOLE_BASE_URL=
```

- [x] **Step 6：Commit**

```bash
git add src/config/env.ts src/config/env.spec.ts .env.example
git commit -m "feat: add AIVIRTEACH_SESSION_TOKEN, rename LABS_CONSOLE_WS_URL to LABS_GUACAMOLE_BASE_URL"
```

---

### Task 3: Server — `LabsClient.createBrowserSession()`，删除 `getCredentials`/`registerConsoleToken`

**Files:**
- Modify: `src/workspace/labs-client.ts`
- Modify: `src/workspace/labs-client.spec.ts`

**Interfaces:**
- Consumes：`ENV.AIVIRTEACH_SESSION_TOKEN`/`AIVIRTEACH_API_TOKEN`（Task 2）。
- Produces：`createBrowserSession(labId: string, subject: string): Promise<BrowserSession>`，`BrowserSession = { labId: string; state: string; data?: string; expiresAt?: string }`。Task 4 直接调这个方法。
- 移除：`getCredentials()`、`registerConsoleToken()`、导出类型 `VmCredentials`（已用 `grep` 核实只被 `workspace.service.ts` 一处调用，删除不影响其它路径）。

- [x] **Step 1：删掉旧方法的测试，写新方法的失败测试**

在 `src/workspace/labs-client.spec.ts` 里，把整个 `describe('LabsClient.getCredentials', ...)` 和 `describe('LabsClient.registerConsoleToken', ...)` 两个块（从 `describe('LabsClient.getCredentials'` 开始到文件末尾）删掉，换成：

```typescript
describe('LabsClient.createBrowserSession', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('缺少 LABS_VM_BASE_URL 或 AIVIRTEACH_SESSION_TOKEN 时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({});
    await expect(client.createBrowserSession('workspace_1', 'user_1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('AIVIRTEACH_SESSION_TOKEN 跟 AIVIRTEACH_API_TOKEN 相同时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_API_TOKEN: 'same-token',
      AIVIRTEACH_SESSION_TOKEN: 'same-token',
    });
    await expect(client.createBrowserSession('workspace_1', 'user_1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('POST /v1/vms/:labId/browser-sessions，state=ready 时把 expires_at 转成 ISO 字符串', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        lab_id: 'workspace_1',
        state: 'ready',
        data: 'encrypted-ticket',
        expires_at: 1798329900000,
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_SESSION_TOKEN: 'session-token',
    });

    const result = await client.createBrowserSession('workspace_1', 'user_1');

    expect(result).toEqual({
      labId: 'workspace_1',
      state: 'ready',
      data: 'encrypted-ticket',
      expiresAt: new Date(1798329900000).toISOString(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-vm.example.com/v1/vms/workspace_1/browser-sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
        body: JSON.stringify({ subject: 'user_1' }),
      }),
    );
  });

  it('配置了 CF Access 时带上 CF-Access 请求头（跟 createVm 一致）', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lab_id: 'workspace_1', state: 'starting' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_SESSION_TOKEN: 'session-token',
      CF_ACCESS_CLIENT_ID: 'cf-id',
      CF_ACCESS_CLIENT_SECRET: 'cf-secret',
    });

    await client.createBrowserSession('workspace_1', 'user_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-vm.example.com/v1/vms/workspace_1/browser-sessions',
      expect.objectContaining({
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'cf-id',
          'CF-Access-Client-Secret': 'cf-secret',
        }),
      }),
    );
  });

  it('state=starting 时没有 data/expiresAt，不报错', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lab_id: 'workspace_1', state: 'starting' }),
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_SESSION_TOKEN: 'session-token',
    });

    const result = await client.createBrowserSession('workspace_1', 'user_1');

    expect(result).toEqual({ labId: 'workspace_1', state: 'starting', data: undefined, expiresAt: undefined });
  });

  it('Labs 返回非 2xx 时抛出带状态码和详情的错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'Command exited with 1.',
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_SESSION_TOKEN: 'session-token',
    });

    await expect(client.createBrowserSession('workspace_1', 'user_1')).rejects.toThrow(
      'Labs 创建浏览器会话失败（502）：Command exited with 1.',
    );
  });
});
```

- [x] **Step 2：跑测试确认失败**

```bash
npm test -- src/workspace/labs-client.spec.ts
```
Expected: 新增用例全部 FAIL（`createBrowserSession` 方法不存在）；旧的 `getCredentials`/`registerConsoleToken` 测试已经删掉，不会再跑。

- [x] **Step 3：删掉旧方法，实现新方法**

在 `src/workspace/labs-client.ts` 里，删掉整个 `getCredentials` 方法（含它上面的 `VmCredentials`/`CredentialsResponseBody` 类型定义）和整个 `registerConsoleToken` 方法。在 `createVm` 方法后面加：

```typescript
export type BrowserSession = {
  labId: string;
  state: string;
  data?: string;
  expiresAt?: string;
};

type BrowserSessionResponseBody = {
  lab_id: string;
  state: string;
  data?: string;
  expires_at?: number;
};

async createBrowserSession(labId: string, subject: string): Promise<BrowserSession> {
  const { LABS_VM_BASE_URL, AIVIRTEACH_SESSION_TOKEN, AIVIRTEACH_API_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } =
    this.env;
  if (!LABS_VM_BASE_URL || !AIVIRTEACH_SESSION_TOKEN) {
    throw new ServiceUnavailableException('Labs 集成未配置：缺少 LABS_VM_BASE_URL 或 AIVIRTEACH_SESSION_TOKEN');
  }
  if (AIVIRTEACH_API_TOKEN && AIVIRTEACH_SESSION_TOKEN === AIVIRTEACH_API_TOKEN) {
    throw new ServiceUnavailableException('AIVIRTEACH_SESSION_TOKEN 不能和 AIVIRTEACH_API_TOKEN 配置成相同的值');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AIVIRTEACH_SESSION_TOKEN}`,
  };
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = CF_ACCESS_CLIENT_SECRET;
  }

  const response = await fetch(`${LABS_VM_BASE_URL}/v1/vms/${labId}/browser-sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ subject }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Labs 创建浏览器会话失败（${response.status}）：${detail || response.statusText}`);
  }

  const body = (await response.json()) as BrowserSessionResponseBody;
  return {
    labId: body.lab_id,
    state: body.state,
    data: body.data,
    expiresAt: body.expires_at !== undefined ? new Date(body.expires_at).toISOString() : undefined,
  };
}
```

- [x] **Step 4：跑测试确认通过**

```bash
npm test -- src/workspace/labs-client.spec.ts
```
Expected: 全部 PASS。

- [x] **Step 5：Commit**

```bash
git add src/workspace/labs-client.ts src/workspace/labs-client.spec.ts
git commit -m "feat: replace LabsClient console-token/credentials methods with createBrowserSession"
```

---

### Task 4: Server — `WorkspaceService.createConsoleSession()` 改造

**Files:**
- Modify: `src/workspace/workspace.service.ts`
- Modify: `src/workspace/workspace.service.spec.ts`
- Modify: `src/workspace/workspace.controller.spec.ts`

**Interfaces:**
- Consumes：`LabsClient.createBrowserSession()`（Task 3）、`ENV.LABS_GUACAMOLE_BASE_URL`（Task 2）。
- Produces：`WorkspaceService.createConsoleSession(userId: string, enrollmentId: string): Promise<ConsoleSessionResult>`，`ConsoleSessionResult = { labId: string; state: string; data?: string; expiresAt?: string; guacamoleBaseUrl?: string }`。`WorkspaceController`（不需要改代码，只是它导入的这个类型形状变了）直接透传这个返回值。

`src/workspace/workspace.controller.ts` **本身不需要改动**——路由方法 `createConsoleSession` 已经是 `return this.workspaceService.createConsoleSession(...)`，类型名 `ConsoleSessionResult` 保持不变，只是它在 `workspace.service.ts` 里的字段形状变了。

- [x] **Step 1：改 service 层测试**

在 `src/workspace/workspace.service.spec.ts` 里，把整个 `describe('WorkspaceService.createConsoleSession', ...)` 块替换成：

```typescript
describe('WorkspaceService.createConsoleSession', () => {
  function buildLabsClient() {
    return {
      createVm: jest.fn(),
      createBrowserSession: jest.fn().mockResolvedValue({
        labId: 'ws_1',
        state: 'ready',
        data: 'encrypted-ticket',
        expiresAt: '2026-08-24T00:05:00.000Z',
      }),
    };
  }

  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService({ labsClient: buildLabsClient() });
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService({ labsClient: buildLabsClient() });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('workspace 状态不是 RUNNING 时拒绝，不调用 Labs', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      labId: null,
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toThrow(ConflictException);
    expect(labsClient.createBrowserSession).not.toHaveBeenCalled();
  });

  it('LABS_GUACAMOLE_BASE_URL 未配置时抛出 ServiceUnavailableException，不调用 Labs', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma } = await buildService({ labsClient, env: { LABS_GUACAMOLE_BASE_URL: undefined } });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(labsClient.createBrowserSession).not.toHaveBeenCalled();
  });

  it('Labs 调用失败时抛出 BadGatewayException，写失败审计', async () => {
    const labsClient = buildLabsClient();
    labsClient.createBrowserSession.mockRejectedValue(new Error('Labs 创建浏览器会话失败（502）：boom'));
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.console-session', success: false, targetId: 'ws_1' }),
    );
  });

  it('state=starting 时透传结果，不带 guacamoleBaseUrl，不写审计', async () => {
    const labsClient = buildLabsClient();
    labsClient.createBrowserSession.mockResolvedValue({ labId: 'ws_1', state: 'starting' });
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    const result = await service.createConsoleSession('user_1', 'enr_1');

    expect(result).toEqual({ labId: 'ws_1', state: 'starting', data: undefined, expiresAt: undefined, guacamoleBaseUrl: undefined });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('state=ready 时透传 data/expiresAt，附带 guacamoleBaseUrl，写成功审计', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
    });

    const result = await service.createConsoleSession('user_1', 'enr_1');

    expect(result).toEqual({
      labId: 'ws_1',
      state: 'ready',
      data: 'encrypted-ticket',
      expiresAt: '2026-08-24T00:05:00.000Z',
      guacamoleBaseUrl: 'https://labs-console.test/guacamole/',
    });
    expect(labsClient.createBrowserSession).toHaveBeenCalledWith('ws_1', 'user_1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.console-session', success: true, targetId: 'ws_1' }),
    );
  });
});
```

`buildService` helper（文件顶部）里默认的 env override 要跟着改：把

```typescript
      { provide: ENV, useValue: { LABS_CONSOLE_WS_URL: 'wss://labs-console.test', ...overrides.env } },
```

改成：

```typescript
      { provide: ENV, useValue: { LABS_GUACAMOLE_BASE_URL: 'https://labs-console.test/guacamole/', ...overrides.env } },
```

- [x] **Step 2：跑测试确认失败**

```bash
npm test -- src/workspace/workspace.service.spec.ts
```
Expected: 新用例 FAIL（`createConsoleSession` 还是旧实现，返回形状对不上、也没有 `createBrowserSession` 这个方法名可调）。

- [x] **Step 3：重写 `WorkspaceService.createConsoleSession`**

在 `src/workspace/workspace.service.ts` 里，把整个 `createConsoleSession` 方法替换成：

```typescript
  async createConsoleSession(userId: string, enrollmentId: string): Promise<ConsoleSessionResult> {
    if (!this.env.LABS_GUACAMOLE_BASE_URL) {
      throw new ServiceUnavailableException('远程桌面服务未配置：缺少 LABS_GUACAMOLE_BASE_URL');
    }

    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.RUNNING) {
      throw new ConflictException('工作区还没准备好，请稍后再试');
    }

    let session: BrowserSession;
    try {
      session = await this.labsClient.createBrowserSession(workspace.labId!, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.console-session',
        success: false,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
      throw new BadGatewayException(`无法连接远程桌面服务：${message}`);
    }

    // 只在真正建立会话（state === "ready"）时写审计；客户端每 2-3 秒轮询一次这个接口，
    // 中间的 "starting"/"unavailable" 响应不是有意义的审计事件，见 Global Constraints。
    if (session.state === 'ready') {
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.console-session',
        success: true,
        targetType: 'Workspace',
        targetId: workspace.id,
      });
    }

    return {
      ...session,
      guacamoleBaseUrl: session.state === 'ready' ? this.env.LABS_GUACAMOLE_BASE_URL : undefined,
    };
  }
```

顶部 import 里，把 `import { generateOpaqueToken } from '../auth/tokens';` 这一行删掉（`createConsoleSession` 不再生成一次性 token，`generateOpaqueToken` 在这个文件里不再被使用；`auth.service.ts`/`admin.service.ts` 里的用法不受影响）；`import { LabsClient } from './labs-client';` 改成 `import { LabsClient, type BrowserSession } from './labs-client';`。

文件顶部把：

```typescript
const CONSOLE_TOKEN_TTL_SECONDS = 300;

export type ConsoleSessionResult = {
  wsUrl: string;
  rdpUsername: string;
  rdpPassword: string;
  expiresAt: string;
};
```

改成：

```typescript
export type ConsoleSessionResult = {
  labId: string;
  state: string;
  data?: string;
  expiresAt?: string;
  guacamoleBaseUrl?: string;
};
```

（`CONSOLE_TOKEN_TTL_SECONDS` 常量整个删掉，不再需要——票据的过期时间由 Labs 决定，不是我们这边生成的。）

- [x] **Step 4：跑测试确认通过**

```bash
npm test -- src/workspace/workspace.service.spec.ts
```
Expected: 全部 PASS。

- [x] **Step 5：改 controller 层测试**

`workspace.controller.ts` 源码不用改，但它的测试 mock 了 `createConsoleSession` 的返回值，形状要跟着换。在 `src/workspace/workspace.controller.spec.ts` 里，把：

```typescript
  it('POST :enrollmentId/console-session 用认证用户的 userId 调用 service.createConsoleSession', async () => {
    const service = {
      createConsoleSession: jest.fn().mockResolvedValue({
        wsUrl: 'wss://labs-console.test/?token=abc',
        rdpUsername: 'learner',
        rdpPassword: 'secret',
        expiresAt: '2026-08-24T00:05:00.000Z',
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceController],
      providers: [{ provide: WorkspaceService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(WorkspaceController);

    const result = await controller.createConsoleSession('enr_1', AUTH_REQUEST as any);

    expect(result.wsUrl).toBe('wss://labs-console.test/?token=abc');
    expect(service.createConsoleSession).toHaveBeenCalledWith('user_1', 'enr_1');
  });
```

改成：

```typescript
  it('POST :enrollmentId/console-session 用认证用户的 userId 调用 service.createConsoleSession', async () => {
    const service = {
      createConsoleSession: jest.fn().mockResolvedValue({
        labId: 'ws_1',
        state: 'ready',
        data: 'encrypted-ticket',
        expiresAt: '2026-08-24T00:05:00.000Z',
        guacamoleBaseUrl: 'https://labs-console.test/guacamole/',
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceController],
      providers: [{ provide: WorkspaceService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(WorkspaceController);

    const result = await controller.createConsoleSession('enr_1', AUTH_REQUEST as any);

    expect(result.state).toBe('ready');
    expect(result.guacamoleBaseUrl).toBe('https://labs-console.test/guacamole/');
    expect(service.createConsoleSession).toHaveBeenCalledWith('user_1', 'enr_1');
  });
```

- [x] **Step 6：跑测试确认通过**

```bash
npm test -- src/workspace/workspace.controller.spec.ts
```
Expected: PASS。

- [x] **Step 7：跑全量测试确认没有破坏其它模块**

```bash
npm test
```
Expected: 全部 PASS（`workspace.gateway.spec.ts` 不受影响，因为源码没动）。

- [x] **Step 8：Commit**

```bash
git add src/workspace/workspace.service.ts src/workspace/workspace.service.spec.ts src/workspace/workspace.controller.spec.ts
git commit -m "feat: rewrite createConsoleSession to forward Labs browser-sessions ticket"
```

---

### Task 5: Client — 依赖 + `ConsoleViewer` 组件重写

**先决条件**：切到 `aivirteach-client` 仓库的 `feat/workspace-vm-orchestration` 分支：

```bash
cd /Users/owenlee/Desktop/2025年/项目/aivirteach-client
git status   # 确认在 feat/workspace-vm-orchestration 分支且工作区干净
```

**Files:**
- Modify: `package.json`
- Modify: `app/workspace/console-viewer.tsx`

**Interfaces:**
- Produces：React 组件 `<ConsoleViewer data={string} guacamoleBaseUrl={string} onError={(message: string) => void} />`，Task 6 在 `/workspace` 页面里用它替换掉现在接 IronRDP 的调用方式。

- [x] **Step 1：卸载 IronRDP 依赖，安装 Guacamole 依赖**

```bash
npm uninstall @devolutions/iron-remote-desktop @devolutions/iron-remote-desktop-rdp
npm install guacamole-common-js@1.5.0
npm install --save-dev @types/guacamole-common-js@1.5.5
```

- [x] **Step 2：整个重写 `console-viewer.tsx`**

用 Task 1 spike 实测确认的 `import` 写法（下面按 spike 最可能的结果 `import * as Guacamole` 写，如果 spike 结果是默认导入，把顶部这一行换成 `import Guacamole from "guacamole-common-js";`）：

```typescript
"use client";

import { useEffect, useRef } from "react";
import * as Guacamole from "guacamole-common-js";

interface ConsoleViewerProps {
  data: string;
  guacamoleBaseUrl: string;
  onError: (message: string) => void;
}

function toWebSocketBase(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/^http/, "ws");
}

/**
 * Wraps the Guacamole web client (`guacamole-common-js`) as a React
 * component. `data` is the opaque, encrypted Guacamole JSON-auth ticket
 * minted by Labs; this component exchanges it for a real Guacamole
 * authToken, then opens a WebSocket tunnel directly to Guacamole.
 */
export function ConsoleViewer({ data, guacamoleBaseUrl, onError }: ConsoleViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let client: Guacamole.Client | null = null;

    async function connect(mountPoint: HTMLDivElement) {
      const tokenResponse = await fetch(`${guacamoleBaseUrl}api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data }),
      });
      if (cancelled) return;
      if (!tokenResponse.ok) {
        throw new Error(`无法建立远程桌面会话（${tokenResponse.status}）`);
      }
      const tokenBody = (await tokenResponse.json()) as { authToken: string };

      const tunnel = new Guacamole.WebSocketTunnel(`${toWebSocketBase(guacamoleBaseUrl)}websocket-tunnel`);
      const guacClient = new Guacamole.Client(tunnel);
      client = guacClient;

      guacClient.onerror = (status) => {
        if (cancelled) return;
        onError(status.message || "远程桌面连接出错");
      };
      tunnel.onerror = (status) => {
        if (cancelled) return;
        onError(status.message || "无法连接远程桌面服务");
      };

      const display = guacClient.getDisplay();
      mountPoint.appendChild(display.getElement());

      // Mouse (unlike Keyboard below) uses guacamole-common-js's newer
      // Event.Target API (on/onEach), not direct onmousedown-style property
      // assignment -- confirmed from the type declarations' own JSDoc example.
      const mouse = new Guacamole.Mouse(display.getElement());
      mouse.onEach(["mousedown", "mousemove", "mouseup"], (event) => {
        guacClient.sendMouseState((event as Guacamole.Mouse.Event).state, true);
      });

      const keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (keysym) => {
        guacClient.sendKeyEvent(1, keysym);
      };
      keyboard.onkeyup = (keysym) => {
        guacClient.sendKeyEvent(0, keysym);
      };

      // 连接参数的具体 key 名以 Task 1 spike 实测结果为准，这里按 spike 记录的默认值填。
      const connectParams = new URLSearchParams({
        token: tokenBody.authToken,
        GUAC_DATA_SOURCE: "json",
        GUAC_TYPE: "c",
      });
      guacClient.connect(connectParams.toString());
    }

    connect(container).catch((error: unknown) => {
      if (!cancelled) onError(error instanceof Error ? error.message : "无法连接远程桌面");
    });

    return () => {
      cancelled = true;
      client?.disconnect();
      if (container) container.innerHTML = "";
    };
  }, [data, guacamoleBaseUrl, onError]);

  return <div ref={containerRef} className="console-viewer" />;
}
```

- [x] **Step 3：`npm run lint` 确认没有新增 lint 错误**

```bash
npm run lint
```
Expected: 无新增错误。如果 `import * as Guacamole from "guacamole-common-js"` 这一行报类型错误（比如"没有默认导出"之类），按 Task 1 Step 3 记录的另一种 import 写法改。

- [ ] **Step 4：对着 Task 1 起的本地 Guacamole+xrdp 环境手工验证**（复用 Task 1 的 docker compose，如果已经 `down -v` 了就重新起一份）

把这个组件临时塞进任意页面（或者直接跳到 Task 6 做完页面接入后一起验证），用 Task 1 Step 2 脚本手工构造的 `data` 传进 `ConsoleViewer`，`guacamoleBaseUrl` 填 `http://localhost:8080/guacamole/`：确认能连上、渲染出真实桌面、键鼠有效。这一步没有自动化测试可写（WASM/WebSocket 实时连接没法很好 mock），手工验证过一遍即可继续。

- [x] **Step 5：Commit**

```bash
git add package.json package-lock.json app/workspace/console-viewer.tsx
git commit -m "feat: rewrite ConsoleViewer to use guacamole-common-js instead of IronRDP"
```

---

### Task 6: Client — 接入 `/workspace` 页面（轮询逻辑）

**Files:**
- Modify: `app/lib/api.ts`
- Modify: `app/workspace/page.tsx`

**Interfaces:**
- Consumes：Server 的 `POST /workspaces/:enrollmentId/console-session`（Task 4）、`ConsoleViewer` 组件（Task 5）。

- [x] **Step 1：`api.ts` 换类型**

把：

```typescript
export type ApiConsoleSession = {
  wsUrl: string;
  rdpUsername: string;
  rdpPassword: string;
  expiresAt: string;
};
```

改成：

```typescript
export type ApiConsoleSession = {
  labId: string;
  state: string;
  data?: string;
  expiresAt?: string;
  guacamoleBaseUrl?: string;
};
```

`api.consoleSession` 方法本身不用改（路径、method 都没变）。

- [x] **Step 2：`page.tsx` 加轮询状态和逻辑**

顶部 import 改：

```typescript
import { ConsoleViewer } from "./console-viewer";
```

（组件名不变，props 变了，Task 5 已经处理。）

在现有：

```typescript
  const [consoleSession, setConsoleSession] = useState<ApiConsoleSession | null>(null);
  const [consoleError, setConsoleError] = useState("");
  const [consoleLoading, setConsoleLoading] = useState(false);
```

后面加两个 ref：一个记录轮询定时器，一个记录"这一轮轮询是否已经作废"（workspace 状态离开 RUNNING、或组件卸载时会置位）——只清定时器不够：如果状态变化/卸载发生在某次 `api.consoleSession()` 请求已经发出、还没返回的当口，`clearTimeout` 只能清掉*还没触发*的下一次定时器，清不掉这次已经在飞行中的请求；不加这个标志位，请求返回后仍会 `setConsoleSession`/`setConsoleLoading`（对着已经卸载的组件调用，或者把已经清空的 `consoleSession` 又设置回去），并且还会排一个新的 `setTimeout`——这个新定时器排上的时候，卸载/状态切换的清理早就跑完了，没有第二次机会去清它，轮询就在后台停不下来。这个模式跟本文件里其它 `useEffect`（`ensureWorkspace`/`measureLatency` 等）用的 `active` 标志位是同一个道理，只是这里要跨一个事件处理函数和两个 `useEffect` 共享，所以用 ref 而不是闭包变量：

```typescript
  const consolePollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consolePollCancelled = useRef(false);
```

把现有的 `startConsoleSession` 函数：

```typescript
  async function startConsoleSession() {
    if (!enrollment) return;
    setConsoleLoading(true);
    setConsoleError("");
    try {
      const session = await api.consoleSession(enrollment.id);
      setConsoleSession(session);
    } catch (caught) {
      setConsoleError(caught instanceof Error ? caught.message : "无法启动远程桌面");
    } finally {
      setConsoleLoading(false);
    }
  }
```

改成带轮询、带 2 分钟超时的版本：

```typescript
  const consolePollDeadlineMs = 2 * 60 * 1000;
  const consolePollIntervalMs = 2500;

  async function startConsoleSession() {
    if (!enrollment) return;
    // 上一轮轮询可能因为超时/报错而结束但定时器已经清空、也可能是用户重新点击重试——
    // 无论哪种情况，开始新一轮之前先把旧状态清干净，保证同一时刻只有一条轮询链在跑。
    if (consolePollTimer.current) {
      clearTimeout(consolePollTimer.current);
      consolePollTimer.current = null;
    }
    consolePollCancelled.current = false;
    setConsoleLoading(true);
    setConsoleError("");
    const deadline = Date.now() + consolePollDeadlineMs;

    async function poll() {
      if (!enrollment) return;
      try {
        const session = await api.consoleSession(enrollment.id);
        if (consolePollCancelled.current) return; // 请求在飞行中时这一轮轮询已经作废，结果直接丢弃
        if (session.state === "ready") {
          setConsoleSession(session);
          setConsoleLoading(false);
          return;
        }
        if (Date.now() >= deadline) {
          setConsoleError("启动超时，请重试");
          setConsoleLoading(false);
          return;
        }
        consolePollTimer.current = setTimeout(() => void poll(), consolePollIntervalMs);
      } catch (caught) {
        if (consolePollCancelled.current) return;
        setConsoleError(caught instanceof Error ? caught.message : "无法启动远程桌面");
        setConsoleLoading(false);
      }
    }

    void poll();
  }
```

在现有清空 `consoleSession` 的 `useEffect`（workspace 状态离开 RUNNING 时）里，顺带清掉轮询定时器：

```typescript
  useEffect(() => {
    if (workspace?.status !== "RUNNING") {
      consolePollCancelled.current = true;
      setConsoleSession(null);
      setConsoleError("");
      if (consolePollTimer.current) {
        clearTimeout(consolePollTimer.current);
        consolePollTimer.current = null;
      }
    }
  }, [workspace?.status]);
```

再加一个卸载时清理定时器的 `useEffect`（放在其它 `useEffect(() => () => {...}, [])` 清理逻辑旁边，跟现有 `refreshTimer` 的清理方式一致）：

```typescript
  useEffect(() => () => {
    consolePollCancelled.current = true;
    if (consolePollTimer.current) clearTimeout(consolePollTimer.current);
  }, []);
```

- [x] **Step 3：更新渲染逻辑**

把现有：

```typescript
          {workspace?.status === "RUNNING" && consoleSession ? (
            <ConsoleViewer
              wsUrl={consoleSession.wsUrl}
              rdpUsername={consoleSession.rdpUsername}
              rdpPassword={consoleSession.rdpPassword}
              onError={handleConsoleError}
            />
          ) : workspace?.status === "RUNNING" ? (
            <section className="vm-empty-state" role="status">
              <span className="vm-display-icon" aria-hidden="true" />
              <h2>Learning VM</h2>
              {consoleError && <p className="auth-error" role="alert">{consoleError}</p>}
              <button className="primary-button" type="button" onClick={() => void startConsoleSession()} disabled={consoleLoading}>
                {consoleLoading ? "Connecting..." : "Start remote desktop"}
              </button>
            </section>
          ) : workspace?.status === "ERROR" ? (
```

改成：

```typescript
          {workspace?.status === "RUNNING" && consoleSession?.state === "ready" && consoleSession.data && consoleSession.guacamoleBaseUrl ? (
            <ConsoleViewer
              data={consoleSession.data}
              guacamoleBaseUrl={consoleSession.guacamoleBaseUrl}
              onError={handleConsoleError}
            />
          ) : workspace?.status === "RUNNING" ? (
            <section className="vm-empty-state" role="status">
              <span className="vm-display-icon" aria-hidden="true" />
              <h2>Learning VM</h2>
              {consoleError && <p className="auth-error" role="alert">{consoleError}</p>}
              <button className="primary-button" type="button" onClick={() => void startConsoleSession()} disabled={consoleLoading}>
                {consoleLoading ? "Starting..." : "Start remote desktop"}
              </button>
            </section>
          ) : workspace?.status === "ERROR" ? (
```

`handleConsoleError` 不用改（已经是 `setConsoleError` + `setConsoleSession(null)`）。

- [x] **Step 4：跑现有测试确认没破坏**

```bash
npm test
```
Expected: `tests/rendered-html.test.mjs` 全部 PASS（这个测试只检查"未选课程"状态下的浅层 HTML，不涉及 RUNNING 状态下的新逻辑，不需要新增用例）。

- [ ] **Step 5：手工验证清单**（对着 Task 1/2/3/4/5 打通的本地环境走一遍；真实 Labs 环境的验证放到 Task 7）

  - [ ] VM 是 RUNNING 时点击 "Start remote desktop" → 按钮显示 "Starting..." → 几秒到几十秒内看到真实桌面画面 → 可以用键鼠操作
  - [ ] 轮询超过 2 分钟未 ready（可以临时把 `consolePollDeadlineMs` 改小成几秒钟测试这条路径，测完改回来）→ 展示"启动超时，请重试"
  - [ ] VM 不是 RUNNING 时 → 不显示按钮，跟现有的 CREATING/ERROR 状态展示逻辑一致
  - [ ] Guacamole 服务没起/票据无效 → 展示明确的错误信息，不是卡死转圈
  - [ ] 关闭/离开页面 → 浏览器原生关闭 WebSocket 连接

- [x] **Step 6：Commit**

```bash
git add app/lib/api.ts app/workspace/page.tsx
git commit -m "feat: poll console-session until ready, wire ConsoleViewer to Guacamole ticket"
```

---

### Task 7: 端到端验证 + 更新部署清单

**先决条件**：无——同源边缘路由这条思路已经放弃（见上面「架构变更记录」第 4 点），Step 1/Step 2 不再需要同事额外搭任何东西，可以自主推进。

**Files:**
- Modify: `aivirteach-server/docs/deployment/labs-cloudflare-tunnel.md`

- [x] **Step 0（2026-08-27 已完成）：用同事提供的真实 Labs 环境做核心链路端到端验证**

用同事发的真实 `AIVIRTEACH_SESSION_TOKEN`/`AIVIRTEACH_API_TOKEN` + 真实 tunnel URL（VM Manager 8760、Guacamole 8090，均为 `trycloudflare.com` quick tunnel），跨域直连（不经过任何同源代理）测了一遍：`POST /v1/vms/lab-001/browser-sessions`（VM 从 `shut off` 被拉起，轮询 `state: starting → ready`）→ 真实票据换 `authToken`（`/guacamole/api/tokens`，200）→ 真实 WebSocket tunnel（`/guacamole/websocket-tunnel`，升级成功，收到 Guacamole 协议握手数据）。全部通过，验证完毕后已用 `POST /v1/vms/lab-001/actions/stop` 把测试用的 VM 关掉。

顺带确认了一件之前记录为待办的事（读 `vm-manager/service.py` 源码 + 这次真实调用都确认）：`create_browser_session` 内部有按 `lab_id` 的 `asyncio.Lock`，且只有确认 VM 处于 `shut off` 才会调用 `VM_CONTROL_SCRIPT start`——客户端轮询期间重复调用这个接口是安全的，不会重复触发 start。**这条不需要再问同事，已经从待办里去掉。**

这次验证跨域直连，测的是"票据格式 + Guacamole 握手协议 + WS tunnel 机制"，不是"server 转发 `/api/tokens`"这一步——后者是本任务剩下的验证缺口，见下面 Step 1。

- [x] **Step 1（2026-08-27 已完成）：server 转发 `/api/tokens` 的代码实现**

新增 `LabsClient.exchangeGuacamoleToken()`（server 对 server 转发 `POST {LABS_GUACAMOLE_BASE_URL}api/tokens`，顺带算出 `websocketUrl`，http/https 自动转 ws/wss）、`WorkspaceService.exchangeConsoleToken()`（enrollment 归属校验 + 错误包装）、`WorkspaceController` 新端点 `POST :enrollmentId/console-session/token`；`env.ts` 新增 `LABS_GUACAMOLE_BASE_URL`（server 端专用，不进浏览器 bundle）。Client 侧 `console-viewer.tsx` 改成调 `api.exchangeConsoleToken()` 换 `authToken`/`websocketUrl`，不再直连 `/guacamole/api/tokens`，也不再依赖任何同源相对路径；`page.tsx` 给 `ConsoleViewer` 传入新增的 `enrollmentId` prop。Server 侧单测全绿（`labs-client.spec.ts`/`workspace.service.spec.ts`/`workspace.controller.spec.ts`），client 侧 `tsc --noEmit` 和 `npm run build` 都过。

- [ ] **Step 2：用真实 Labs 环境重新验证一遍，这次要经过 server 转发**

Task 7 Step 0 是浏览器跨域直连 Guacamole 测的，没有验证 server 转发这一步。这次要在 server 配上真实 `LABS_GUACAMOLE_BASE_URL`（同事给的 Guacamole tunnel 地址），走真实的 `POST :enrollmentId/console-session/token` 端点，确认 server→Guacamole 的转发、`websocketUrl` 拼接、浏览器跨域开 WS 这条完整链路没问题。

- [ ] **Step 3：Server 侧配置真实生产环境变量**（Vercel）

`AIVIRTEACH_SESSION_TOKEN`（跟 Labs 主机上同名变量的值完全一致，且确认它跟 `AIVIRTEACH_API_TOKEN` 不是同一个值）、`LABS_GUACAMOLE_BASE_URL`（同事给的 Guacamole tunnel 地址，含路径前缀且以斜杠结尾）——这是账号设置改动，需要真实值和用户明确授权，不是能自动化的一步。

- [ ] **Step 4：完整走一遍学员视角流程**

学员登录 → 进 `/workspace` → 等 VM RUNNING → 点 "Start remote desktop" → （如果 VM 之前是关机的）看到 "Starting..." → 看到真实桌面 → 操作 → 关闭页面。

- [ ] **Step 5：更新部署清单**

按设计文档"部署清单更新"一节列的几点，更新 [`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md)：删掉 `websockify` 部署那节；环境变量清单换成 `AIVIRTEACH_SESSION_TOKEN` + `LABS_GUACAMOLE_BASE_URL`；连通性验证排障指引改成 Guacamole 相关的失败模式（含 quick tunnel 地址失效后 `LABS_GUACAMOLE_BASE_URL` 要跟着手动更新这条）。

- [ ] **Step 6：Commit**

```bash
git add docs/deployment/labs-cloudflare-tunnel.md
git commit -m "docs: update deployment checklist for Guacamole console setup"
```
