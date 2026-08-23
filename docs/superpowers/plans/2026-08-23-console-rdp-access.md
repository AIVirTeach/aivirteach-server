# Console/RDP 远程桌面接入（浏览器 IronRDP 方案）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学员在 `/workspace` 页面点一下按钮，直接在浏览器里看到、操作自己那台 Labs VM 的真实 RDP 桌面——不装任何东西。

**Architecture:** 浏览器里嵌入 IronRDP 官方 Web 组件（WASM），通过 `websockify`（TokenFile 动态路由模式）转发到 Labs 主机内网 VM 的 RDP 端口。Server 新增一个鉴权接口，在同一次请求里生成一次性路由 token、登记给 Labs、现取密码、一起返回给浏览器。详见 [设计文档](../specs/2026-08-23-console-rdp-access-design.md)。

**Tech Stack:** NestJS/Prisma（server）、FastAPI + bash（labs）、Next.js (RSC, `vinext`/Cloudflare Workers) + `@devolutions/iron-remote-desktop` + `@devolutions/iron-remote-desktop-rdp`（client）。

## Global Constraints

- 一次性 token 有效期 **5 分钟**，只用于告诉 `websockify` 该转发到哪台 VM，不做身份验证（身份验证已经由既有 JWT 会话完成）。
- **不新增任何 Prisma model**——token 在同一个 HTTP 请求里生成、注册、返回，不落库，不需要哈希存储或二次核销。
- `rdp_password`（Labs 字段名是 `password`，不是 `rdp_password`）绝不落库、绝不写日志，服务端现取现用现扔，直传给浏览器响应。
- 不引入 Cloudflare Access Service Token、不锁定 `cloudflared` 版本——这次浏览器方案完全不需要它们。
- websockify 的 TokenFile 过期清理，作为 `register-console-token` 子命令自身的一部分执行（每次注册前先清理旧文件），不单独配置 cron。
- 三个仓库分别是 `aivirteach-server`（当前仓库）、`aivirteach-labs`、`aivirteach-client`，均为本机 `/Users/owenlee/Desktop/2025年/项目/` 下的同级目录。
- **分支前提（重要，执行前必读）**：
  - `aivirteach-server`：这次的改动依赖 PR #8（`docs/workspace-vm-orchestration-spec` 分支）里的 `src/workspace/` 模块（`WorkspaceController`/`WorkspaceService`/`LabsClient` 等），但 PR #8 还没合并到 `main`。当前分支 `docs/console-rdp-access-spec`（PR #9）是在 PR #8 合并前从 `main` 切出来的，没有这些文件。**Task 4 开始前，先把 `docs/workspace-vm-orchestration-spec` 合并/rebase 进当前分支**，确认 `src/workspace/` 目录存在再继续（这跟 PR #8 本身"文档分支上继续堆功能提交"是同一个仓库惯例，不是新发明的流程）。
  - `aivirteach-client`：Task 7/8 的改动基于 PR #3（`feat/workspace-vm-orchestration` 分支）已有的 `/workspace` 页面和 `app/lib/api.ts`，请在该分支上继续，不要从 `main` 切新分支。
  - `aivirteach-labs`：Task 2/3 直接在 `main`（当前唯一分支）上继续，这个仓库还没有这次改动相关的进行中分支。

---

### Task 1: Spike — 验证 IronRDP Web 组件 + websockify 真的能连上 xrdp

**这是验证性任务，不产出会合并进最终 PR 的代码**，纯粹是为了在写任何服务端/Labs 代码之前，先确认"浏览器 WASM RDP 客户端通过 websockify 转发连真实 xrdp"这条路径走得通——这是整个设计里唯一没有查到已知先例的集成点，如果这一步走不通，后面的任务全部要重新评估，所以必须排第一个。

**环境**：找一台已经在跑的 Labs 学员 VM（用现有的 `POST /v1/vms` + `vm-control.sh credentials`/`ip` 手工建一台，或者用已有的测试 VM）。

- [ ] **Step 1：在 Labs 主机上手工装并起 `websockify`**

```bash
# Labs 主机上（不是本地开发机）
pip install websockify  # 或用发行版包管理器
mkdir -p /tmp/console-tokens
```

- [ ] **Step 2：手工查出测试 VM 的内网 IP 和 RDP 端口，写一条 TokenFile 记录**

```bash
cd aivirteach-labs/libvirt
./scripts/vm-control.sh ip <测试用的 lab_id>          # 得到 192.168.122.x
./scripts/vm-control.sh credentials <测试用的 lab_id>  # 得到 username/password/rdp_port
echo "spike-test-token: 192.168.122.x:3389" > /tmp/console-tokens/spike-test-token
```

- [ ] **Step 3：用 TokenFile 插件启动 websockify，监听一个测试端口**

```bash
websockify --token-plugin=TokenFile --token-source=/tmp/console-tokens 6080
```

确认命令能正常起来、不报错退出。如果 `--token-plugin=TokenFile` 参数名跟实际版本对不上（不同发行版打包的 websockify 版本可能有出入），先查 `websockify --help` 核对真实参数名，记录下来供 Task 2 使用。

- [ ] **Step 4：本地起一个最小的 HTML 测试页，引入 IronRDP 官方 Web 组件**

不需要在 `aivirteach-client` 仓库里改任何东西，单独建一个临时目录：

```bash
mkdir -p /tmp/ironrdp-spike && cd /tmp/ironrdp-spike
npm init -y
npm install @devolutions/iron-remote-desktop @devolutions/iron-remote-desktop-rdp
```

去 [Devolutions/IronRDP 仓库的 `web-client/iron-svelte-client`](https://github.com/Devolutions/IronRDP/tree/master/web-client) 目录读一遍它的用法（这是官方给的示范客户端），照着它的方式搭一个最小页面：引入这两个包、注册 Web 组件、把 `wsUrl` 指向 `ws://<labs主机地址>:6080/?token=spike-test-token`（websockify 需要 SSH 隧道或临时开放端口才能从本地开发机连到 Labs 主机，用最省事的方式打通，比如临时 SSH 端口转发）、用户名密码填测试 VM 的真实值。

- [ ] **Step 5：浏览器打开测试页，验证真的能看到桌面**

用 Chrome/浏览器打开这个本地测试页，检查：
- WebSocket 连接建立成功（DevTools Network 面板能看到 101 Switching Protocols）
- RDP 握手完成，`<canvas>` 里渲染出测试 VM 的真实桌面画面（不是空白/错误）
- 能用鼠标点击、键盘输入，VM 里有对应反应

- [ ] **Step 6：记录发现，做 go/no-go 判断**

在这次会话里（不需要建文件）跟人类伙伴同步：
- 组件实际的 HTML 标签名/attribute 名/事件名是什么（供 Task 7 写真实组件用）
- `websockify` 的确切启动参数（供 Task 2 写运维文档/子命令用）
- 如果哪一步失败：记录清楚失败在哪、报什么错，STOP，回去跟人类伙伴讨论要不要调整设计（比如换用 Devolutions Gateway 而不是裸 `websockify`），不要跳过验证直接往下走。

**只有这一步验证通过，才能继续 Task 2。**

---

### Task 2: Labs — `register-console-token` 子命令

**Files:**
- Modify: `aivirteach-labs/libvirt/config/defaults.env`
- Modify: `aivirteach-labs/libvirt/scripts/vm-control.sh`
- Modify: `aivirteach-labs/libvirt/tests/static-checks.sh`

**Interfaces:**
- Produces：命令行接口 `vm-control.sh register-console-token LAB_ID TOKEN TTL_SECONDS`，成功时无 stdout 输出，非 0 退出码表示失败（跟其余子命令一致）；Task 3 的 `service.py` 路由通过 `run_script()` 调用它。

- [ ] **Step 1：在 `defaults.env` 里加两个配置项**

在 `libvirt/config/defaults.env` 的 `RDP_PORT="3389"` 那一行后面加：

```bash
CONSOLE_TOKEN_DIR="/etc/aivirteach-labs/console-tokens"
CONSOLE_TOKEN_TTL_SECONDS="300"
```

（`CONSOLE_TOKEN_TTL_SECONDS` 这里是防御性的默认值，实际 TTL 由调用方传入，这个默认值只在没传参时兜底用不到——真正生效的是 Task 3 里 server 传过来的 `ttl_seconds`。）

- [ ] **Step 2：改 `vm-control.sh` 的 usage 字符串和参数解析**

现在的 `vm-control.sh` 是 `ACTION LAB_ID [--yes]` 的两参数模式，`register-console-token` 需要额外两个位置参数（`TOKEN`、`TTL_SECONDS`），跟现有 `[--yes]` 可选 flag 的解析方式不一样，单独在最前面判断：

```bash
# 第 8 行，原来的 usage() 改成：
usage() { echo "Usage: $0 {start|stop|force-stop|reboot|status|ip|vnc|credentials|register-console-token|delete} LAB_ID [--yes]"; }

# 第 9-14 行附近，在 require_root_or_sudo 之前插入特殊参数处理
# （register-console-token 不需要 root，也不走 DOMAIN_EXISTS 判断，跟其它子命令分支处理）
if [[ "$ACTION" == "register-console-token" ]]; then
  CONSOLE_TOKEN="${1:?Missing token}"
  CONSOLE_TTL_SECONDS="${2:?Missing ttl_seconds}"
  shift 2
fi
```

这段插入在第 11 行 `validate_lab_id "$LAB_ID"` 之后、第 14 行 `require_root_or_sudo` 之前。

- [ ] **Step 3：在 `case "$ACTION" in` 里加新分支**

在 `credentials)` 分支（第 37-41 行）后面加：

```bash
  register-console-token)
    CRED_FILE="${STATE_DIR}/${LAB_ID}/credentials.txt"
    [[ -f "$CRED_FILE" ]] || die "Credential file not found"
    RDP_TARGET_PORT="$(grep '^rdp_port=' "$CRED_FILE" | cut -d= -f2)"
    [[ -n "$RDP_TARGET_PORT" ]] || die "rdp_port not found in credentials file"

    [[ "$DOMAIN_EXISTS" == true ]] || die "VM not found"
    IP="$(get_vm_ip "$LAB_ID")"
    [[ -n "$IP" ]] || die "No IPv4 address reported yet."

    as_root install -d -m 0750 -o root -g libvirt "$CONSOLE_TOKEN_DIR"
    as_root find "$CONSOLE_TOKEN_DIR" -maxdepth 1 -type f -mmin "+$((CONSOLE_TTL_SECONDS / 60))" -delete

    as_root bash -c "umask 077; printf '%s: %s:%s\n' '$CONSOLE_TOKEN' '$IP' '$RDP_TARGET_PORT' > '${CONSOLE_TOKEN_DIR}/${CONSOLE_TOKEN}'"
    ;;
```

（复用现有 `credentials` 分支读文件的方式、`ip` 分支查 IP 的方式——`register-console-token` 本质是把这两步的结果拼成 websockify 要的格式写到一个新文件里，没有新逻辑。清理过期文件用 `find -mmin` 是近似的 TTL 判断，跟 Task 3 传入的 `ttl_seconds` 换算成分钟对齐，足够 MVP 用。）

- [ ] **Step 4：`bash -n` 静态检查通过**

```bash
cd aivirteach-labs && bash -n libvirt/scripts/vm-control.sh
```
Expected: 无输出，退出码 0。

- [ ] **Step 5：手工冒烟测试（复用 Task 1 起的那台测试 VM）**

```bash
cd aivirteach-labs/libvirt
./scripts/vm-control.sh register-console-token <测试lab_id> smoke-test-token 300
cat /etc/aivirteach-labs/console-tokens/smoke-test-token
# 期待输出形如：smoke-test-token: 192.168.122.x:3389
```

- [ ] **Step 6：`static-checks.sh` 加一行新检查**

在 `libvirt/tests/static-checks.sh` 第 11 行 `grep -q 'qemu-img create' ...` 后面加一行：

```bash
grep -q 'register-console-token' "$ROOT/scripts/vm-control.sh"
```

- [ ] **Step 7：跑一遍完整静态检查**

```bash
cd aivirteach-labs && bash libvirt/tests/static-checks.sh
```
Expected: 输出 `Static checks passed.`

- [ ] **Step 8：Commit**

```bash
cd aivirteach-labs
git add libvirt/config/defaults.env libvirt/scripts/vm-control.sh libvirt/tests/static-checks.sh
git commit -m "feat: add register-console-token subcommand for websockify TokenFile routing"
```

---

### Task 3: Labs — `POST /v1/vms/{lab_id}/console-token` 路由

**Files:**
- Modify: `aivirteach-labs/service.py`
- Modify: `aivirteach-labs/tests/test_service.py`

**Interfaces:**
- Produces：`POST /v1/vms/{lab_id}/console-token`，body `{"token": string, "ttl_seconds": int}`，鉴权同其余 `/v1/vms/*` 路由（`Depends(require_api_token)`）。成功返回 `{"lab_id": str, "registered": true}`；失败时 `run_script` 抛的 `HTTPException` 原样冒泡（跟其余路由一致，不用额外 try/except）。
- Consumes：Task 2 的 `vm-control.sh register-console-token LAB_ID TOKEN TTL_SECONDS`。

- [ ] **Step 1：写失败测试**

在 `tests/test_service.py` 的 `test_ip_response` 后面加：

```python
    async def test_register_console_token_calls_script_with_correct_argv(self) -> None:
        runner = AsyncMock(return_value="")
        with patch.object(service, "run_script", runner):
            response = await self.client.post(
                "/v1/vms/lab-001/console-token",
                headers=self.auth,
                json={"token": "abc123", "ttl_seconds": 300},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"lab_id": "lab-001", "registered": True})
        argv = runner.await_args.args[0]
        self.assertEqual(
            [str(item) for item in argv],
            [str(service.VM_CONTROL_SCRIPT), "register-console-token", "lab-001", "abc123", "300"],
        )
```

- [ ] **Step 2：跑测试确认失败**

```bash
cd aivirteach-labs && python -m pytest tests/test_service.py -k register_console_token -v
```
Expected: FAIL（`404 Not Found`，路由还不存在）。

- [ ] **Step 3：加 Pydantic 请求模型和路由**

在 `service.py` 里，`class CreateVMRequest` 后面加：

```python
class ConsoleTokenRequest(BaseModel):
    token: str = Field(min_length=1, max_length=128)
    ttl_seconds: int = Field(ge=1, le=3600)
```

在 `vm_credentials` 路由（`/v1/vms/{lab_id}/credentials`）后面加新路由：

```python
@app.post(
    "/v1/vms/{lab_id}/console-token",
    dependencies=[Depends(require_api_token)],
    tags=["vms"],
)
async def register_console_token(lab_id: str, request: ConsoleTokenRequest) -> dict[str, str | bool]:
    lab_id = _validate_lab_id(lab_id)
    await run_script(
        [
            VM_CONTROL_SCRIPT,
            "register-console-token",
            lab_id,
            request.token,
            str(request.ttl_seconds),
        ]
    )
    return {"lab_id": lab_id, "registered": True}
```

- [ ] **Step 4：跑测试确认通过**

```bash
cd aivirteach-labs && python -m pytest tests/test_service.py -k register_console_token -v
```
Expected: PASS。

- [ ] **Step 5：跑全量测试确认没有破坏其它路由**

```bash
cd aivirteach-labs && python -m pytest tests/test_service.py -v
```
Expected: 全部 PASS。

- [ ] **Step 6：Commit**

```bash
cd aivirteach-labs
git add service.py tests/test_service.py
git commit -m "feat: add POST /v1/vms/{lab_id}/console-token route"
```

---

### Task 4: Server — 合并 PR #8 分支 + 新增 `LABS_CONSOLE_WS_URL` 环境变量

**先决条件**：回到 `aivirteach-server` 仓库，把 `docs/workspace-vm-orchestration-spec` 合并进当前分支：

```bash
cd /Users/owenlee/Desktop/2025年/项目/aivirteach-server
git merge docs/workspace-vm-orchestration-spec
```

确认合并后 `src/workspace/` 目录存在（`ls src/workspace/`），且 `npm test` 能跑通（这一步只是让代码基础就位，不是这个 Task 的交付物，不算独立步骤）。

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces：`Env.LABS_CONSOLE_WS_URL: string | undefined`，Task 6 的 `WorkspaceController`/`WorkspaceService` 会用它拼 `wsUrl`。

- [ ] **Step 1：写测试**

在 `src/config/env.spec.ts` 里，找到"把数字型变量从字符串强制转换"那个 `it` 块后面加：

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

- [ ] **Step 2：跑测试确认失败**

```bash
npm test -- src/config/env.spec.ts
```
Expected: 第二个新测试 FAIL（现在任何字符串都会被当成缺失的可选字段直接跳过校验，不会抛错——因为字段还不存在于 schema 里）。

- [ ] **Step 3：在 `EnvSchema` 里加字段**

在 `src/config/env.ts` 的 `CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),` 后面加：

```typescript
  // websockify 对外的 wss:// 基础地址，给浏览器建 RDP WebSocket 连接用；
  // 跟 LABS_VM_BASE_URL（VM 生命周期 HTTP API）是两个不同用途的地址。
  LABS_CONSOLE_WS_URL: z.url().optional(),
```

- [ ] **Step 4：跑测试确认通过**

```bash
npm test -- src/config/env.spec.ts
```
Expected: PASS。

- [ ] **Step 5：`.env.example` 加说明**

在 `.env.example` 末尾加：

```bash
# Labs 主机上 websockify 的 wss:// 地址（Console/RDP 浏览器直连用）
LABS_CONSOLE_WS_URL=
```

- [ ] **Step 6：Commit**

```bash
git add src/config/env.ts src/config/env.spec.ts .env.example
git commit -m "feat: add LABS_CONSOLE_WS_URL env var"
```

---

### Task 5: Server — `LabsClient.getCredentials()` + `LabsClient.registerConsoleToken()`

**Files:**
- Modify: `src/workspace/labs-client.ts`
- Modify: `src/workspace/labs-client.spec.ts`

**Interfaces:**
- Consumes：`ENV`（`LABS_VM_BASE_URL`/`AIVIRTEACH_API_TOKEN`/`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`，已存在）。
- Produces：
  - `getCredentials(labId: string): Promise<{ password: string }>`
  - `registerConsoleToken(labId: string, token: string, ttlSeconds: number): Promise<void>`
  Task 6 直接调这两个方法。

- [ ] **Step 1：写 `getCredentials` 的失败测试（缺配置）**

在 `src/workspace/labs-client.spec.ts` 里，`describe('LabsClient.createVm', ...)` 后面加两个新的 `describe` 块：

```typescript
describe('LabsClient.getCredentials', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('缺少 Labs 配置时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({});
    await expect(client.getCredentials('workspace_1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('GET /v1/vms/:labId/credentials，只透出 password 字段', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lab_id: 'workspace_1', username: 'learner', password: 'secret', rdp_port: 3389 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_API_TOKEN: 'labs-token',
    });

    const result = await client.getCredentials('workspace_1');

    expect(result).toEqual({ password: 'secret' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-vm.example.com/v1/vms/workspace_1/credentials',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer labs-token' }),
      }),
    );
  });

  it('Labs 返回非 2xx 时抛出带状态码和详情的错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Credential file not found',
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_API_TOKEN: 'labs-token',
    });

    await expect(client.getCredentials('workspace_1')).rejects.toThrow(
      'Labs 获取凭据失败（404）：Credential file not found',
    );
  });
});

describe('LabsClient.registerConsoleToken', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('缺少 Labs 配置时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({});
    await expect(client.registerConsoleToken('workspace_1', 'tok', 300)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('POST /v1/vms/:labId/console-token，带上 token 和 ttlSeconds', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ registered: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_API_TOKEN: 'labs-token',
    });

    await client.registerConsoleToken('workspace_1', 'tok-abc', 300);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-vm.example.com/v1/vms/workspace_1/console-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'tok-abc', ttl_seconds: 300 }),
      }),
    );
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
      AIVIRTEACH_API_TOKEN: 'labs-token',
    });

    await expect(client.registerConsoleToken('workspace_1', 'tok', 300)).rejects.toThrow(
      'Labs 登记 console token 失败（502）：Command exited with 1.',
    );
  });
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
npm test -- src/workspace/labs-client.spec.ts
```
Expected: 新增的用例全部 FAIL（`getCredentials`/`registerConsoleToken` 还不存在）。

- [ ] **Step 3：实现两个方法**

在 `src/workspace/labs-client.ts` 里，`createVm` 方法后面加：

```typescript
export type VmCredentials = {
  password: string;
};

type CredentialsResponseBody = {
  password: string;
};

async getCredentials(labId: string): Promise<VmCredentials> {
  const { LABS_VM_BASE_URL, AIVIRTEACH_API_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = this.env;
  if (!LABS_VM_BASE_URL || !AIVIRTEACH_API_TOKEN) {
    throw new ServiceUnavailableException('Labs 集成未配置：缺少 LABS_VM_BASE_URL 或 AIVIRTEACH_API_TOKEN');
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${AIVIRTEACH_API_TOKEN}` };
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = CF_ACCESS_CLIENT_SECRET;
  }

  const response = await fetch(`${LABS_VM_BASE_URL}/v1/vms/${labId}/credentials`, { headers });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Labs 获取凭据失败（${response.status}）：${detail || response.statusText}`);
  }

  const body = (await response.json()) as CredentialsResponseBody;
  return { password: body.password };
}

async registerConsoleToken(labId: string, token: string, ttlSeconds: number): Promise<void> {
  const { LABS_VM_BASE_URL, AIVIRTEACH_API_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = this.env;
  if (!LABS_VM_BASE_URL || !AIVIRTEACH_API_TOKEN) {
    throw new ServiceUnavailableException('Labs 集成未配置：缺少 LABS_VM_BASE_URL 或 AIVIRTEACH_API_TOKEN');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AIVIRTEACH_API_TOKEN}`,
  };
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = CF_ACCESS_CLIENT_SECRET;
  }

  const response = await fetch(`${LABS_VM_BASE_URL}/v1/vms/${labId}/console-token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token, ttl_seconds: ttlSeconds }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Labs 登记 console token 失败（${response.status}）：${detail || response.statusText}`);
  }
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
npm test -- src/workspace/labs-client.spec.ts
```
Expected: 全部 PASS。

- [ ] **Step 5：Commit**

```bash
git add src/workspace/labs-client.ts src/workspace/labs-client.spec.ts
git commit -m "feat: add LabsClient.getCredentials and registerConsoleToken"
```

---

### Task 6: Server — `POST /workspaces/:enrollmentId/console-session`

**Files:**
- Modify: `src/workspace/workspace.service.ts`
- Modify: `src/workspace/workspace.service.spec.ts`
- Modify: `src/workspace/workspace.controller.ts`
- Modify: `src/workspace/workspace.controller.spec.ts`

**Interfaces:**
- Consumes：`LabsClient.getCredentials()`/`registerConsoleToken()`（Task 5）、`generateOpaqueToken()`（`src/auth/tokens.ts`，已存在）、`ENV.LABS_CONSOLE_WS_URL`（Task 4）、`AuditService.record()`（已存在）。
- Produces：`WorkspaceService.createConsoleSession(userId: string, enrollmentId: string): Promise<ConsoleSessionResult>`，`ConsoleSessionResult = { wsUrl: string; rdpUsername: string; rdpPassword: string; expiresAt: string }`。控制器路由 `POST /workspaces/:enrollmentId/console-session` 直接透传这个返回值。

- [ ] **Step 1：写 service 层失败测试**

在 `src/workspace/workspace.service.spec.ts` 文件末尾加新的 `describe` 块：

```typescript
describe('WorkspaceService.createConsoleSession', () => {
  function buildLabsClient() {
    return {
      createVm: jest.fn(),
      getCredentials: jest.fn().mockResolvedValue({ password: 'secret-pw' }),
      registerConsoleToken: jest.fn().mockResolvedValue(undefined),
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
      rdpUsername: null,
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toThrow(ConflictException);
    expect(labsClient.registerConsoleToken).not.toHaveBeenCalled();
    expect(labsClient.getCredentials).not.toHaveBeenCalled();
  });

  it('Labs 登记 token 失败时抛出 BadGatewayException，不透出内部错误信息', async () => {
    const labsClient = buildLabsClient();
    labsClient.registerConsoleToken.mockRejectedValue(new Error('Labs 登记 console token 失败（502）：boom'));
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(labsClient.getCredentials).not.toHaveBeenCalled();
  });

  it('Labs 取密码失败时抛出 BadGatewayException', async () => {
    const labsClient = buildLabsClient();
    labsClient.getCredentials.mockRejectedValue(new Error('Labs 获取凭据失败（404）：boom'));
    const { service, prisma } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    await expect(service.createConsoleSession('user_1', 'enr_1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('RUNNING 时：登记 token、取密码、组装返回值', async () => {
    const labsClient = buildLabsClient();
    const { service, prisma, audit } = await buildService({ labsClient });
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.RUNNING,
      labId: 'ws_1',
      rdpUsername: 'learner',
    });

    const result = await service.createConsoleSession('user_1', 'enr_1');

    expect(result.rdpUsername).toBe('learner');
    expect(result.rdpPassword).toBe('secret-pw');
    expect(result.wsUrl).toMatch(/^wss:\/\/labs-console\.test\/\?token=/);
    expect(labsClient.registerConsoleToken).toHaveBeenCalledWith('ws_1', expect.any(String), 300);
    expect(labsClient.getCredentials).toHaveBeenCalledWith('ws_1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.console-session', success: true, targetId: 'ws_1' }),
    );
  });
});
```

这个测试需要 `buildService` helper 提供 `ENV`——检查 `src/workspace/workspace.service.spec.ts` 顶部的 `buildService` 函数，加一个默认 provider `{ provide: ENV, useValue: { LABS_CONSOLE_WS_URL: 'wss://labs-console.test' } }`（跟 `PrismaService`/`AuditService` 等其它 provider 同样的 `overrides` 模式），文件顶部 import 里加 `ENV`、`BadGatewayException`。

- [ ] **Step 2：跑测试确认失败**

```bash
npm test -- src/workspace/workspace.service.spec.ts
```
Expected: 新增用例 FAIL（`createConsoleSession` 方法不存在）。

- [ ] **Step 3：实现 `WorkspaceService.createConsoleSession`**

在 `src/workspace/workspace.service.ts` 顶部 import 里改成：

```typescript
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { generateOpaqueToken } from '../auth/tokens';
```

构造函数加 `ENV` 注入：

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly labsClient: LabsClient,
    private readonly gateway: WorkspaceGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}
```

`getForEnrollment` 方法后面加新方法：

```typescript
  async createConsoleSession(userId: string, enrollmentId: string): Promise<ConsoleSessionResult> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');
    if (workspace.status !== WorkspaceStatus.RUNNING) {
      throw new ConflictException('工作区还没准备好，请稍后再试');
    }

    // status === RUNNING 时 labId/rdpUsername 一定有值——两者在 provisionInBackground 里
    // 跟 status 更新是同一次 prisma.workspace.update() 调用，不会出现「RUNNING 但缺字段」的状态。
    const token = generateOpaqueToken();
    const ttlSeconds = CONSOLE_TOKEN_TTL_SECONDS;
    let credentialsPassword: string;
    try {
      await this.labsClient.registerConsoleToken(workspace.labId!, token, ttlSeconds);
      credentialsPassword = (await this.labsClient.getCredentials(workspace.labId!)).password;
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      throw new BadGatewayException(`无法连接远程桌面服务：${message}`);
    }

    await this.audit.record({
      actor: { type: AuditActorType.USER, id: userId },
      action: 'workspace.console-session',
      success: true,
      targetType: 'Workspace',
      targetId: workspace.id,
    });

    return {
      wsUrl: `${this.env.LABS_CONSOLE_WS_URL}/?token=${token}`,
      rdpUsername: workspace.rdpUsername!,
      rdpPassword: credentialsPassword,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }
```

文件顶部（`STALE_CREATING_MS` 常量旁边）加：

```typescript
const CONSOLE_TOKEN_TTL_SECONDS = 300;

export type ConsoleSessionResult = {
  wsUrl: string;
  rdpUsername: string;
  rdpPassword: string;
  expiresAt: string;
};
```

- [ ] **Step 4：跑测试确认通过**

```bash
npm test -- src/workspace/workspace.service.spec.ts
```
Expected: 全部 PASS。

- [ ] **Step 5：controller 层——写失败测试**

在 `src/workspace/workspace.controller.spec.ts` 里，`describe('WorkspaceController', ...)` 内最后一个 `it` 后面加：

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

- [ ] **Step 6：跑测试确认失败**

```bash
npm test -- src/workspace/workspace.controller.spec.ts
```
Expected: FAIL（`controller.createConsoleSession` 不存在）。

- [ ] **Step 7：加控制器路由**

在 `src/workspace/workspace.controller.ts` 里，`create` 方法后面加：

```typescript
  @Post(':enrollmentId/console-session')
  createConsoleSession(
    @Param('enrollmentId') enrollmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConsoleSessionResult> {
    return this.workspaceService.createConsoleSession(request.auth!.userId, enrollmentId);
  }
```

顶部 import 加 `type ConsoleSessionResult` from `./workspace.service`。

- [ ] **Step 8：跑测试确认通过**

```bash
npm test -- src/workspace/workspace.controller.spec.ts
```
Expected: 全部 PASS。

- [ ] **Step 9：跑全量测试确认没有破坏其它模块**

```bash
npm test
```
Expected: 全部 PASS。

- [ ] **Step 10：Commit**

```bash
git add src/workspace/workspace.service.ts src/workspace/workspace.service.spec.ts \
        src/workspace/workspace.controller.ts src/workspace/workspace.controller.spec.ts
git commit -m "feat: add POST /workspaces/:enrollmentId/console-session"
```

---

### Task 7: Client — IronRDP 依赖 + `ConsoleViewer` 组件

**先决条件**：切到 `aivirteach-client` 仓库的 `feat/workspace-vm-orchestration` 分支（`git -C ../aivirteach-client checkout feat/workspace-vm-orchestration`）。

**Files:**
- Modify: `aivirteach-client/package.json`
- Create: `aivirteach-client/app/workspace/console-viewer.tsx`

**Interfaces:**
- Produces：React 组件 `<ConsoleViewer wsUrl={string} rdpUsername={string} rdpPassword={string} onError={(message: string) => void} />`，Task 8 在 `/workspace` 页面里用它替换掉原来的静态 `vmUrl` iframe。

- [ ] **Step 1：安装依赖**

```bash
cd ../aivirteach-client
npm install @devolutions/iron-remote-desktop @devolutions/iron-remote-desktop-rdp
```

- [ ] **Step 2：写组件**

根据 Task 1 spike 里实测确认的组件标签名/attribute/事件名（Task 1 的 Step 6 已经记录下来），写 `app/workspace/console-viewer.tsx`。下面是骨架，`<iron-remote-desktop>` 具体的 attribute/事件名以 spike 实测结果为准替换：

```typescript
"use client";

import { useEffect, useRef, useState } from "react";

interface ConsoleViewerProps {
  wsUrl: string;
  rdpUsername: string;
  rdpPassword: string;
  onError: (message: string) => void;
}

export function ConsoleViewer({ wsUrl, rdpUsername, rdpPassword, onError }: ConsoleViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { registerRdpModule } = await import("@devolutions/iron-remote-desktop-rdp");
      await import("@devolutions/iron-remote-desktop");
      if (cancelled) return;
      registerRdpModule();
      setReady(true);
    }

    connect().catch((error) => {
      if (!cancelled) onError(error instanceof Error ? error.message : "无法加载远程桌面组件");
    });

    return () => {
      cancelled = true;
    };
  }, [onError]);

  if (!ready) return null;

  return (
    <div ref={containerRef} className="console-viewer">
      {/* iron-remote-desktop 的具体 props/事件绑定，按 Task 1 spike 实测结果填 */}
    </div>
  );
}
```

- [ ] **Step 3：对着 Task 1 起的那台真实测试 VM，手工验证**

在本地临时把这个组件塞进任意一个页面（或者直接跳到 Task 8 做完页面接入后再验证，两者选一个更省事的顺序都可以）：确认能连上、渲染出真实桌面、键鼠有效。这一步没有自动化测试可写（跟 Task 1 spike 同样的原因——WASM RDP 连接没法很好 mock），手工验证过一遍即可继续。

- [ ] **Step 4：`npm run lint` 确认没有新增 lint 错误**

```bash
npm run lint
```
Expected: 无新增错误。

- [ ] **Step 5：Commit**

```bash
git add package.json package-lock.json app/workspace/console-viewer.tsx
git commit -m "feat: add ConsoleViewer component wrapping IronRDP web client"
```

---

### Task 8: Client — 接入 `/workspace` 页面

**Files:**
- Modify: `aivirteach-client/app/lib/api.ts`
- Modify: `aivirteach-client/app/workspace/page.tsx`

**Interfaces:**
- Consumes：Server 的 `POST /workspaces/:enrollmentId/console-session`（Task 6）、`ConsoleViewer` 组件（Task 7）。

- [ ] **Step 1：`api.ts` 加类型和方法**

在 `export type ApiWorkspace = {...}` 后面加：

```typescript
export type ApiConsoleSession = {
  wsUrl: string;
  rdpUsername: string;
  rdpPassword: string;
  expiresAt: string;
};
```

在 `api` 对象里，`createWorkspace` 后面加：

```typescript
  consoleSession: (enrollmentId: string) =>
    request<ApiConsoleSession>("/workspaces/" + encodeURIComponent(enrollmentId) + "/console-session", {
      method: "POST",
    }),
```

- [ ] **Step 2：`page.tsx` 引入组件，加状态**

顶部 import 加：

```typescript
import { ConsoleViewer } from "./console-viewer";
```

`import { api, ApiError, ... }` 那一行加上 `type ApiConsoleSession`。

在现有 `const [vmEnvOpen, setVmEnvOpen] = useState(false);` 后面加：

```typescript
  const [consoleSession, setConsoleSession] = useState<ApiConsoleSession | null>(null);
  const [consoleError, setConsoleError] = useState("");
  const [consoleLoading, setConsoleLoading] = useState(false);
```

在 `retryWorkspace` 函数后面加：

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

- [ ] **Step 3：替换渲染逻辑**

把现有这一段（`<main className="lab-workspace vm-workspace">` 内部）：

```typescript
          {workspace?.status === "RUNNING" && vmUrl ? (
            <iframe className="vm-frame" src={vmUrl} title="Interactive learning virtual machine" allow="clipboard-read; clipboard-write; fullscreen" />
          ) : workspace?.status === "ERROR" ? (
```

改成：

```typescript
          {workspace?.status === "RUNNING" && consoleSession ? (
            <ConsoleViewer
              wsUrl={consoleSession.wsUrl}
              rdpUsername={consoleSession.rdpUsername}
              rdpPassword={consoleSession.rdpPassword}
              onError={(message) => { setConsoleError(message); setConsoleSession(null); }}
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

文件顶部不再需要 `const vmUrl = process.env.NEXT_PUBLIC_LEARNING_VM_URL;` 这一行，删掉它（这次改动之后不再有任何地方引用 `vmUrl`）。

- [ ] **Step 4：跑现有测试确认没破坏**

```bash
npm test
```
Expected: `tests/rendered-html.test.mjs` 全部 PASS（这个测试只检查 `/workspace` 在"未选课程"状态下渲染出 "Opening Learning Lab" 文案，不涉及 RUNNING 状态下的新逻辑，不需要新增用例——这个仓库目前唯一的自动化测试就是这种构建后的浅层 HTML 冒烟测试，跟这次改动无关的部分不用额外补）。

- [ ] **Step 5：手工验证清单**（对着 Task 1/2/3/4/5/6 打通的真实环境走一遍）

  - [ ] VM 是 RUNNING 时点击 "Start remote desktop" → 几秒内看到真实桌面画面 → 可以用键鼠操作
  - [ ] VM 不是 RUNNING 时 → 不显示按钮，跟现有的 CREATING/ERROR 状态展示逻辑一致
  - [ ] Labs 主机上 `websockify` 没起/token 已过期 → 展示明确的错误信息，不是卡死转圈
  - [ ] 关闭/离开页面 → 浏览器原生关闭 WebSocket 连接

- [ ] **Step 6：Commit**

```bash
git add app/lib/api.ts app/workspace/page.tsx
git commit -m "feat: wire /workspace page to console-session and ConsoleViewer"
```

---

### Task 9: 端到端手工验证 + 更新部署清单

**Files:**
- Modify: `aivirteach-server/docs/deployment/labs-cloudflare-tunnel.md`

- [ ] **Step 1：在 Labs 主机上把 `websockify` 配成正式服务**（不是 Task 1 那种手工前台运行）

按 Task 1 spike 里记录下来的真实启动参数，配一个 `systemd` unit，让它开机自启、监听在固定端口。

- [ ] **Step 2：给 Cloudflare Tunnel 加 `labs-console.<domain>` 的 WSS 路由**

指向 `websockify` 监听的本地端口，普通 HTTP(S)/WSS hostname 路由（不是 Access 私有网络应用）。

- [ ] **Step 3：Server 侧配置 `LABS_CONSOLE_WS_URL`**（Vercel 环境变量）指向 `wss://labs-console.<domain>`。

- [ ] **Step 4：完整走一遍学员视角流程**

学员登录 → 进 `/workspace` → 等 VM RUNNING → 点 "Start remote desktop" → 看到真实桌面 → 操作 → 关闭页面。

- [ ] **Step 5：更新部署清单**

按设计文档"部署清单更新"一节列的三点，更新 [`docs/deployment/labs-cloudflare-tunnel.md`](../../deployment/labs-cloudflare-tunnel.md)：`labs-console.<domain>` 从占位变成生效配置、加 `websockify` 部署步骤、删掉遗留的 `cloudflared` 版本锁定/Access Service Token 相关内容。

- [ ] **Step 6：Commit**

```bash
git add docs/deployment/labs-cloudflare-tunnel.md
git commit -m "docs: update deployment checklist for console/RDP websockify setup"
```
