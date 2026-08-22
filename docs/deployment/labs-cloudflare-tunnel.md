# Labs Cloudflare Tunnel 部署清单

> 面向负责 Cloudflare Tunnel / Access 配置的同事。这里全是 Cloudflare 后台配置 + Labs 主机上装
> `cloudflared`，不涉及写代码。基于 `aivirteach-server` PR #8（workspace VM 编排）和
> `aivirteach-labs` 仓库当前实际代码核对，取代设计文档里那份写在实现之前的旧清单。

## 现状核对：server 端实际会调用什么

`src/workspace/labs-client.ts` 目前**只**调用 Labs 的 `POST /v1/vms`（建 VM），没有调用诊断/agent
相关接口。对应 `src/config/env.ts` 里实际加的 4 个环境变量：

```
LABS_VM_BASE_URL=https://<labs-vm 的 tunnel 域名>
AIVIRTEACH_API_TOKEN=<和 Labs 主机 config/api.env 里同名变量的值完全一致>
CF_ACCESS_CLIENT_ID=<下面第 2 步生成的 Service Token>
CF_ACCESS_CLIENT_SECRET=<下面第 2 步生成的 Service Token>
```

这四个都在 server 里标记为**可选**（不配置的话，本地/CI 照常跑，只有真正调用 `LabsClient` 时才报错），
所以这份清单不是"必须立刻做完 server 才能跑"，而是"要让 `/workspace` 页面真的建出 VM，必须做完"。

`LABS_AGENT_BASE_URL`（诊断 agent 用）**当前没有在 server 代码里出现** —— Console/诊断功能还在
"未来单独立项"阶段（见设计文档"不做的事"一节），所以本轮不需要为 `labs-agent` 配 Access + Service
Token，只需要预留路由位置（见下面第 1 步第 3 条）。

## 1. Labs 主机上实际跑的服务（核对自 `aivirteach-labs` 仓库）

Labs 是三个独立进程，各自 systemd unit，默认全部绑定 `127.0.0.1`（见
`aivirteach-labs/config/api.env.example`），不能从外网直连，必须靠本机的 `cloudflared` 转发：

| 端口 | systemd unit | 作用 | 这次要不要接 Tunnel |
| --- | --- | --- | --- |
| `8760` | `aivirteach-labs.service` | VM Manager（`POST /v1/vms` 就在这） | **要**，server 直接调用它 |
| `8765` | `aivirteach-labs-gateway.service` | 只读诊断 Gateway | **不要**——README 里写死只接受来自 `127.0.0.1:8760` 的请求，对外暴露没有意义，反而多一个攻击面 |
| `8770` | `aivirteach-agent.service` | 课程感知诊断 Agent | 暂不需要，server 还没有调用它的代码 |

Tunnel ingress 规则：

```
labs-vm.<domain>      → http://127.0.0.1:8760   # 这次唯一需要生效的一条
labs-agent.<domain>   → http://127.0.0.1:8770   # 先占位保留 hostname，Access 应用可以先不建
```

`8765` 不写 ingress 规则、不建 hostname。

## 2. Cloudflare Access Application + Service Token

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

最后把 `LABS_VM_BASE_URL=https://labs-vm.<domain>`、`AIVIRTEACH_API_TOKEN`、`CF_ACCESS_CLIENT_ID`、
`CF_ACCESS_CLIENT_SECRET` 四个填进 server 的 Vercel 项目环境变量，重新部署，走一遍
`/workspace` 页面的手动验证（design spec 里 Task 7 Step 6，也是目前 PR #8 / PR #3 测试计划里唯一没打钩的一项）。

## 明确不在这份清单范围内

- Server（`aivirteach-server`）自己的 Vercel 部署配置——这是另一件事，不属于 Labs Tunnel
- `WorkspaceGateway` 的 WebSocket 端点（`/api/v1/workspaces/socket`）——这是 server 自己暴露给
  client 浏览器的，走 server 自己的公网地址，不经过这条 Labs Tunnel，不需要在这里配置
- Console/VNC 直连 Labs（Guacamole 网关）——单独立项，`labs-agent`、`labs-console` 之类的 hostname
  只是预留位置，这次不需要建对应的 Access Application
