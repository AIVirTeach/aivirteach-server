# Workspace VM 编排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Client 落地 `/workspace` 页时，Server 中转调用 Labs 的 `POST /v1/vms` 创建学习者 VM，并通过 WebSocket
把创建结果（成功/失败）实时推给 Client。

**Architecture:** Server 新增 `WorkspaceModule`（Controller + Service + LabsClient + WebSocket Gateway）。
Labs 的 `POST /v1/vms` 是同步阻塞调用（最长 180s），Server 用 `@vercel/functions` 的 `waitUntil()` 在返回
202 之后继续跑这次调用，跑完就落库并通过 WebSocket 广播。Client 新增两个 REST 调用
（`GET/POST /workspaces`）和一个原生 WebSocket 订阅，替换掉 `workspace/page.tsx` 里原来"假设 VM 一直存在"
的逻辑。

**Tech Stack:** NestJS 11、Prisma 6、Zod、`@nestjs/websockets` + `@nestjs/platform-ws`（原生 `ws`，不用
socket.io）、`@vercel/functions`（`waitUntil`）、Next.js 16 App Router、浏览器原生 `WebSocket`。

## Global Constraints

- Labs 侧的 `service.py` 不改一行代码，直接用它现有的 `POST /v1/vms` 接口。
- `Workspace` 表已经在 `prisma/schema.prisma` 里存在并且迁移已应用（`20260821050000_full_control_plane_schema_incremental`），这次不新增/修改 Prisma migration。
- **不持久化 Labs 返回的 RDP 明文密码**——`Workspace` 表没有存密码的字段，`LabsClient.createVm` 的返回类型也
  故意不包含它；`libvirt/README.md` 自己都写了"For production, replace plaintext credential files with
  encrypted, short-lived secrets"，这次不需要用到密码（不连接 VM，只是把它建起来），没必要提前落库一个不用
  的明文密钥。以后做 Console/Guacamole 那部分时，直接现调 `GET /v1/vms/{lab_id}/credentials` 拿新鲜的，
  不要复用这次存的东西（这次根本不存）。
- 同理这次不落 `ip`/`vncPort`——`POST /v1/vms` 的响应里没有这两个字段（需要另外调
  `GET /v1/vms/{lab_id}/ip`、`GET /v1/vms/{lab_id}/vnc`），这次没有任何代码路径需要用到它们，留给以后的
  Console 工作按需现查。
- 所有新增 Labs 相关环境变量（`LABS_VM_BASE_URL`、`AIVIRTEACH_API_TOKEN`、`CF_ACCESS_CLIENT_ID`、
  `CF_ACCESS_CLIENT_SECRET`）在 `src/config/env.ts` 里是 `.optional()` 的——本地开发/CI 不配这几个变量也要能
  正常跑其他模块，缺配置只在真正调用 `LabsClient` 时报错，不在进程启动时让整个 server 起不来。
- Part B（client）依赖 Part A 已经部署到 Vercel 并且 Cloudflare Tunnel/Access 已经按 Part A Task 1 附带的
  部署清单配置好——Part B 的手动验证需要真实的 `GET/POST /workspaces` 能打通到真实 Labs。

---

## Part A — Server（`aivirteach-server`）

### Task 1: `LabsClient` — 封装调用 Labs `POST /v1/vms`

**Files:**
- Modify: `src/config/env.ts`
- Create: `src/workspace/labs-client.ts`
- Test: `src/workspace/labs-client.spec.ts`

**Interfaces:**
- Produces: `LabsClient.createVm(labId: string): Promise<{ labId: string; username: string; rdpPort: number }>`
  （不含密码），未配置 Labs 环境变量时抛 `ServiceUnavailableException`，Labs 返回非 2xx 时抛
  `Error('Labs 创建 VM 失败（<status>）：<detail>')`。

- [ ] **Step 1: 写失败的测试**

创建 `src/workspace/labs-client.spec.ts`：

```typescript
import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { LabsClient } from './labs-client';

const BASE_ENV: Env = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'x'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 4000,
  CORS_ORIGINS: 'http://localhost:3001',
};

async function buildClient(envOverrides: Partial<Env>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      LabsClient,
      { provide: ENV, useValue: { ...BASE_ENV, ...envOverrides } },
    ],
  }).compile();
  return moduleRef.get(LabsClient);
}

describe('LabsClient.createVm', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('缺少 Labs 配置时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({});
    await expect(client.createVm('workspace_1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('POST /v1/vms，带上 bearer token 和 CF Access header，解析成功响应', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lab_id: 'workspace_1', username: 'learner', rdp_password: 'secret', rdp_port: 3389 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_API_TOKEN: 'labs-token',
      CF_ACCESS_CLIENT_ID: 'cf-id',
      CF_ACCESS_CLIENT_SECRET: 'cf-secret',
    });

    const result = await client.createVm('workspace_1');

    expect(result).toEqual({ labId: 'workspace_1', username: 'learner', rdpPort: 3389 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-vm.example.com/v1/vms',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer labs-token',
          'CF-Access-Client-Id': 'cf-id',
          'CF-Access-Client-Secret': 'cf-secret',
        }),
      }),
    );
  });

  it('Labs 返回非 2xx 时抛出带状态码和详情的错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 504,
      statusText: 'Gateway Timeout',
      text: async () => 'Command timed out after 180 seconds.',
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_VM_BASE_URL: 'https://labs-vm.example.com',
      AIVIRTEACH_API_TOKEN: 'labs-token',
    });

    await expect(client.createVm('workspace_1')).rejects.toThrow(
      'Labs 创建 VM 失败（504）：Command timed out after 180 seconds.',
    );
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- labs-client`
Expected: FAIL（`Cannot find module './labs-client'`，因为 `labs-client.ts` 还不存在）

- [ ] **Step 3: 在 `src/config/env.ts` 加 4 个可选环境变量**

在 `EnvSchema` 里 `CORS_ORIGINS` 那行后面加：

```typescript
  // Labs 的 VM 生命周期接口——本地/CI 不配这几个也要能跑，缺配置只在真正调用
  // LabsClient 时报错，不在进程启动时让整个 server 起不来。
  LABS_VM_BASE_URL: z.string().url().optional(),
  AIVIRTEACH_API_TOKEN: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),
```

- [ ] **Step 4: 实现 `src/workspace/labs-client.ts`**

```typescript
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

export type CreateVmResult = {
  labId: string;
  username: string;
  rdpPort: number;
};

type CreateVmResponseBody = {
  lab_id: string;
  username: string;
  rdp_password: string;
  rdp_port: number;
};

// Labs 的 POST /v1/vms 最长阻塞 180 秒（CREATE_TIMEOUT_SECONDS），留够余量。
const CREATE_VM_TIMEOUT_MS = 200_000;

@Injectable()
export class LabsClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async createVm(labId: string): Promise<CreateVmResult> {
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

    const response = await fetch(`${LABS_VM_BASE_URL}/v1/vms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lab_id: labId }),
      signal: AbortSignal.timeout(CREATE_VM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Labs 创建 VM 失败（${response.status}）：${detail || response.statusText}`);
    }

    // rdp_password 故意不读取、不透出——这次不需要连接 VM，没必要提前经手一个不用的明文密钥，
    // 见本文档 Global Constraints。
    const body = (await response.json()) as CreateVmResponseBody;
    return { labId: body.lab_id, username: body.username, rdpPort: body.rdp_port };
  }
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- labs-client`
Expected: PASS（3 个测试全过）

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/workspace/labs-client.ts src/workspace/labs-client.spec.ts
git commit -m "feat: add LabsClient for calling Labs POST /v1/vms"
```

---

### Task 2: `WorkspaceGateway` — WebSocket 状态推送

**Files:**
- Modify: `src/main.ts`
- Create: `src/workspace/workspace.gateway.ts`
- Test: `src/workspace/workspace.gateway.spec.ts`

**Interfaces:**
- Consumes: `verifyAccessToken(token: string, secret: string): Promise<{ sub: string; email: string }>`（已存在，`src/auth/tokens.ts`）
- Produces: `WorkspaceGateway.broadcastStatus(workspace: { id: string; enrollmentId: string; status: string; [key: string]: unknown }): void`——只广播给订阅了同一个 `enrollmentId` 的连接。

- [ ] **Step 1: 装依赖**

```bash
npm install @nestjs/websockets@^11.2.1 @nestjs/platform-ws@^11.2.1 ws@^8.21.3
npm install -D @types/ws
```

- [ ] **Step 2: 写失败的测试**

创建 `src/workspace/workspace.gateway.spec.ts`：

```typescript
jest.mock('../auth/tokens');

import { Test } from '@nestjs/testing';
import { ENV, type Env } from '../config/env';
import { verifyAccessToken } from '../auth/tokens';
import { WorkspaceGateway } from './workspace.gateway';

const mockedVerify = verifyAccessToken as jest.MockedFunction<typeof verifyAccessToken>;

const BASE_ENV: Env = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'x'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 4000,
  CORS_ORIGINS: 'http://localhost:3001',
};

function buildSocket() {
  return { readyState: 1, OPEN: 1, send: jest.fn(), close: jest.fn(), on: jest.fn() } as any;
}

async function buildGateway() {
  const moduleRef = await Test.createTestingModule({
    providers: [WorkspaceGateway, { provide: ENV, useValue: BASE_ENV }],
  }).compile();
  return moduleRef.get(WorkspaceGateway);
}

describe('WorkspaceGateway', () => {
  afterEach(() => jest.resetAllMocks());

  it('缺少 token 或 enrollmentId 时直接关闭连接', async () => {
    const gateway = await buildGateway();
    const socket = buildSocket();
    await gateway.handleConnection(socket, { url: '/api/v1/workspaces/socket?enrollmentId=e1' } as any);
    expect(socket.close).toHaveBeenCalled();
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('token 无效时关闭连接', async () => {
    mockedVerify.mockRejectedValue(new Error('invalid'));
    const gateway = await buildGateway();
    const socket = buildSocket();
    await gateway.handleConnection(socket, { url: '/api/v1/workspaces/socket?token=bad&enrollmentId=e1' } as any);
    expect(socket.close).toHaveBeenCalled();
  });

  it('token 有效时按 enrollmentId 订阅，broadcastStatus 只推给匹配的连接', async () => {
    mockedVerify.mockResolvedValue({ sub: 'user_1', email: 'a@b.com' });
    const gateway = await buildGateway();
    const matching = buildSocket();
    const other = buildSocket();

    await gateway.handleConnection(matching, { url: '/api/v1/workspaces/socket?token=good&enrollmentId=e1' } as any);
    await gateway.handleConnection(other, { url: '/api/v1/workspaces/socket?token=good&enrollmentId=e2' } as any);

    const workspace = { id: 'w1', enrollmentId: 'e1', status: 'RUNNING' };
    gateway.broadcastStatus(workspace as any);

    expect(matching.send).toHaveBeenCalledWith(JSON.stringify({ type: 'workspace.status', workspace }));
    expect(other.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `npm test -- workspace.gateway`
Expected: FAIL（`Cannot find module './workspace.gateway'`）

- [ ] **Step 4: 实现 `src/workspace/workspace.gateway.ts`**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { ENV, type Env } from '../config/env';
import { verifyAccessToken } from '../auth/tokens';

type WorkspaceSocket = WebSocket & { enrollmentId?: string };

type BroadcastableWorkspace = { id: string; enrollmentId: string; status: string; [key: string]: unknown };

// 浏览器原生 WebSocket 不能带自定义请求头，鉴权 token 只能放 query string——
// 跟 access token 15 分钟 TTL 配套，泄露到日志里的窗口很短，可以接受。
@WebSocketGateway({ path: '/api/v1/workspaces/socket' })
@Injectable()
export class WorkspaceGateway implements OnGatewayConnection {
  private readonly sockets = new Set<WorkspaceSocket>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  async handleConnection(client: WorkspaceSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? '', 'http://internal');
    const token = url.searchParams.get('token');
    const enrollmentId = url.searchParams.get('enrollmentId');

    if (!token || !enrollmentId) {
      client.close(4001, '缺少 token 或 enrollmentId');
      return;
    }

    try {
      await verifyAccessToken(token, this.env.JWT_SECRET);
    } catch {
      client.close(4001, 'token 无效或已过期');
      return;
    }

    client.enrollmentId = enrollmentId;
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
  }

  broadcastStatus(workspace: BroadcastableWorkspace): void {
    const payload = JSON.stringify({ type: 'workspace.status', workspace });
    for (const socket of this.sockets) {
      if (socket.enrollmentId === workspace.enrollmentId && socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
```

- [ ] **Step 5: 在 `src/main.ts` 注册 WS adapter**

在 `import { AppModule } from './app.module';` 下面加一行：

```typescript
import { WsAdapter } from '@nestjs/platform-ws';
```

在 `const app = await NestFactory.create(AppModule);` 后面加一行：

```typescript
  app.useWebSocketAdapter(new WsAdapter(app));
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `npm test -- workspace.gateway`
Expected: PASS（3 个测试全过）

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main.ts src/workspace/workspace.gateway.ts src/workspace/workspace.gateway.spec.ts
git commit -m "feat: add WorkspaceGateway for pushing workspace status over WebSocket"
```

---

### Task 3: `WorkspaceService` — 编排逻辑（创建 + 查询 + 过期回收）

**Files:**
- Create: `src/workspace/workspace.service.ts`
- Test: `src/workspace/workspace.service.spec.ts`

**Interfaces:**
- Consumes: `LabsClient.createVm`（Task 1）、`WorkspaceGateway.broadcastStatus`（Task 2）、
  `AuditService.record(input: RecordAuditEventInput): Promise<void>`（已存在，`src/audit/audit.service.ts`）、
  `PrismaService`（已存在）。
- Produces:
  - `WorkspaceService.getForEnrollment(userId: string, enrollmentId: string): Promise<Workspace>`
  - `WorkspaceService.create(userId: string, enrollmentId: string): Promise<Workspace>`
  - `WorkspaceService.provisionInBackground(workspaceId: string, userId: string): Promise<void>`
    （不是 `private`，方便测试直接调用、绕开 `waitUntil`）

- [ ] **Step 1: 装依赖**

```bash
npm install @vercel/functions@^3.9.5
```

- [ ] **Step 2: 写失败的测试**

创建 `src/workspace/workspace.service.spec.ts`：

```typescript
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LabsClient } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceService } from './workspace.service';

function buildPrisma() {
  return {
    enrollment: { findUnique: jest.fn() },
    workspace: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  };
}

async function buildService(
  overrides: { prisma?: ReturnType<typeof buildPrisma>; labsClient?: any; gateway?: any; audit?: any } = {},
) {
  const prisma = overrides.prisma ?? buildPrisma();
  const labsClient = overrides.labsClient ?? { createVm: jest.fn() };
  const gateway = overrides.gateway ?? { broadcastStatus: jest.fn() };
  const audit = overrides.audit ?? { record: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkspaceService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: LabsClient, useValue: labsClient },
      { provide: WorkspaceGateway, useValue: gateway },
    ],
  }).compile();
  return { service: moduleRef.get(WorkspaceService), prisma, labsClient, gateway, audit };
}

const ENROLLMENT = { id: 'enr_1', userId: 'user_1', courseId: 'course_1', active: true };

describe('WorkspaceService.getForEnrollment', () => {
  it('enrollment 不属于当前用户时拒绝', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue({ ...ENROLLMENT, userId: 'someone_else' });
    await expect(service.getForEnrollment('user_1', 'enr_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('没有 workspace 记录时 404', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.getForEnrollment('user_1', 'enr_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('CREATING 超过 5 分钟视为过期，标记 ERROR', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const stale = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.CREATING,
      createdAt: new Date(Date.now() - 6 * 60 * 1000),
    };
    prisma.workspace.findUnique.mockResolvedValue(stale);
    prisma.workspace.update.mockResolvedValue({ ...stale, status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' });

    const result = await service.getForEnrollment('user_1', 'enr_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' },
    });
    expect(result.status).toBe(WorkspaceStatus.ERROR);
  });

  it('CREATING 未超过 5 分钟时原样返回，不改状态', async () => {
    const { service, prisma } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const fresh = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.CREATING, createdAt: new Date() };
    prisma.workspace.findUnique.mockResolvedValue(fresh);

    const result = await service.getForEnrollment('user_1', 'enr_1');

    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(result).toBe(fresh);
  });
});

describe('WorkspaceService.create', () => {
  it('已有非 ERROR 状态的 workspace 时直接返回，不重新创建', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    const existing = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING };
    prisma.workspace.findUnique.mockResolvedValue(existing);

    const result = await service.create('user_1', 'enr_1');

    expect(result).toBe(existing);
    expect(labsClient.createVm).not.toHaveBeenCalled();
    expect(prisma.workspace.upsert).not.toHaveBeenCalled();
  });

  it('没有 workspace 时创建 CREATING 记录并立刻返回（不等 Labs）', async () => {
    const { service, prisma, labsClient } = await buildService();
    prisma.enrollment.findUnique.mockResolvedValue(ENROLLMENT);
    prisma.workspace.findUnique.mockResolvedValue(null);
    const created = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.CREATING };
    prisma.workspace.upsert.mockResolvedValue(created);
    labsClient.createVm.mockReturnValue(new Promise(() => {})); // 故意挂起，模拟还没返回

    const result = await service.create('user_1', 'enr_1');

    expect(result).toBe(created);
    expect(prisma.workspace.upsert).toHaveBeenCalledWith({
      where: { enrollmentId: 'enr_1' },
      update: { status: WorkspaceStatus.CREATING, errorMessage: null },
      create: { enrollmentId: 'enr_1', status: WorkspaceStatus.CREATING },
    });
  });
});

describe('WorkspaceService.provisionInBackground', () => {
  it('Labs 创建成功：落库 RUNNING、写审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    labsClient.createVm.mockResolvedValue({ labId: 'ws_1', username: 'learner', rdpPort: 3389 });
    const updated = { id: 'ws_1', enrollmentId: 'enr_1', status: WorkspaceStatus.RUNNING };
    prisma.workspace.update.mockResolvedValue(updated);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: {
        status: WorkspaceStatus.RUNNING,
        labId: 'ws_1',
        rdpUsername: 'learner',
        rdpPort: 3389,
        errorMessage: null,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.create', success: true, targetId: 'ws_1' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
  });

  it('Labs 失败：落库 ERROR、写失败审计、广播', async () => {
    const { service, prisma, labsClient, gateway, audit } = await buildService();
    labsClient.createVm.mockRejectedValue(new Error('Labs 创建 VM 失败（504）：Command timed out after 180 seconds.'));
    const updated = {
      id: 'ws_1',
      enrollmentId: 'enr_1',
      status: WorkspaceStatus.ERROR,
      errorMessage: 'Labs 创建 VM 失败（504）：Command timed out after 180 seconds.',
    };
    prisma.workspace.update.mockResolvedValue(updated);

    await service.provisionInBackground('ws_1', 'user_1');

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: {
        status: WorkspaceStatus.ERROR,
        errorMessage: 'Labs 创建 VM 失败（504）：Command timed out after 180 seconds.',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.create', success: false, targetId: 'ws_1' }),
    );
    expect(gateway.broadcastStatus).toHaveBeenCalledWith(updated);
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `npm test -- workspace.service`
Expected: FAIL（`Cannot find module './workspace.service'`）

- [ ] **Step 4: 实现 `src/workspace/workspace.service.ts`**

```typescript
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType, WorkspaceStatus, type Workspace } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LabsClient } from './labs-client';
import { WorkspaceGateway } from './workspace.gateway';

const STALE_CREATING_MS = 5 * 60 * 1000;

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly labsClient: LabsClient,
    private readonly gateway: WorkspaceGateway,
  ) {}

  async getForEnrollment(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const workspace = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });
    if (!workspace) throw new NotFoundException('没有找到这个课程的工作区');

    if (workspace.status === WorkspaceStatus.CREATING && this.isStale(workspace)) {
      return this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: WorkspaceStatus.ERROR, errorMessage: '创建超时，请重试' },
      });
    }
    return workspace;
  }

  async create(userId: string, enrollmentId: string): Promise<Workspace> {
    const enrollment = await this.requireOwnedEnrollment(userId, enrollmentId);
    const existing = await this.prisma.workspace.findUnique({ where: { enrollmentId: enrollment.id } });

    // 已经在建或已经好了：直接把现状交回去，不重复发起创建（DB 唯一约束也会挡，这里提前短路更省事）。
    if (existing && existing.status !== WorkspaceStatus.ERROR) return existing;

    const workspace = await this.prisma.workspace.upsert({
      where: { enrollmentId: enrollment.id },
      update: { status: WorkspaceStatus.CREATING, errorMessage: null },
      create: { enrollmentId: enrollment.id, status: WorkspaceStatus.CREATING },
    });

    // Labs 的 POST /v1/vms 最长阻塞 180 秒；用 waitUntil 在这次请求返回 202 之后继续跑，
    // 不让 client 裸等。函数实例中途被回收会丢掉这次后台任务——这是选这个简单方案接受的代价，
    // 靠 getForEnrollment 里的 5 分钟过期判断兜底，见本文档 Global Constraints。
    waitUntil(this.provisionInBackground(workspace.id, userId));
    return workspace;
  }

  // 不是 private：测试直接调用它，绕开 waitUntil 的运行时行为。
  async provisionInBackground(workspaceId: string, userId: string): Promise<void> {
    try {
      const result = await this.labsClient.createVm(workspaceId);
      const updated = await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          status: WorkspaceStatus.RUNNING,
          labId: result.labId,
          rdpUsername: result.username,
          rdpPort: result.rdpPort,
          errorMessage: null,
        },
      });
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.create',
        success: true,
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      this.gateway.broadcastStatus(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      const updated = await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: WorkspaceStatus.ERROR, errorMessage: message },
      });
      await this.audit.record({
        actor: { type: AuditActorType.USER, id: userId },
        action: 'workspace.create',
        success: false,
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      this.gateway.broadcastStatus(updated);
    }
  }

  private isStale(workspace: Workspace): boolean {
    return Date.now() - workspace.createdAt.getTime() > STALE_CREATING_MS;
  }

  private async requireOwnedEnrollment(userId: string, enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment || enrollment.userId !== userId) {
      throw new ForbiddenException('无权访问这个 enrollment');
    }
    return enrollment;
  }
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- workspace.service`
Expected: PASS（8 个测试全过）

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/workspace/workspace.service.ts src/workspace/workspace.service.spec.ts
git commit -m "feat: add WorkspaceService orchestrating Labs VM creation"
```

---

### Task 4: `WorkspaceController` + 模块注册

**Files:**
- Create: `src/workspace/workspace.schemas.ts`
- Create: `src/workspace/workspace.controller.ts`
- Create: `src/workspace/workspace.module.ts`
- Modify: `src/app.module.ts`
- Test: `src/workspace/workspace.controller.spec.ts`

**Interfaces:**
- Produces: `GET /api/v1/workspaces/:enrollmentId`（200 / 404 / 403），`POST /api/v1/workspaces`（202，body
  `{ enrollmentId: string }`）。

- [ ] **Step 1: 写失败的测试**

创建 `src/workspace/workspace.controller.spec.ts`：

```typescript
import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

const JWT_AUTH_GUARD_STUB = { provide: ENV, useValue: { JWT_SECRET: 'test-secret' } };
const AUTH_REQUEST = { auth: { userId: 'user_1', email: 'learner@example.com' } };

describe('WorkspaceController', () => {
  it('GET :enrollmentId 用认证用户的 userId 调用 service.getForEnrollment', async () => {
    const service = { getForEnrollment: jest.fn().mockResolvedValue({ id: 'ws_1' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceController],
      providers: [{ provide: WorkspaceService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(WorkspaceController);

    await expect(controller.get('enr_1', AUTH_REQUEST as any)).resolves.toEqual({ id: 'ws_1' });
    expect(service.getForEnrollment).toHaveBeenCalledWith('user_1', 'enr_1');
  });

  it('POST 用认证用户的 userId 和 body.enrollmentId 调用 service.create', async () => {
    const service = { create: jest.fn().mockResolvedValue({ id: 'ws_1', status: 'CREATING' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceController],
      providers: [{ provide: WorkspaceService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(WorkspaceController);

    await expect(controller.create({ enrollmentId: 'enr_1' }, AUTH_REQUEST as any)).resolves.toEqual({
      id: 'ws_1',
      status: 'CREATING',
    });
    expect(service.create).toHaveBeenCalledWith('user_1', 'enr_1');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- workspace.controller`
Expected: FAIL（`Cannot find module './workspace.controller'`）

- [ ] **Step 3: 实现 `src/workspace/workspace.schemas.ts`**

```typescript
import { z } from 'zod';

export const CreateWorkspaceSchema = z.object({
  enrollmentId: z.string().min(1),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
```

- [ ] **Step 4: 实现 `src/workspace/workspace.controller.ts`**

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Workspace } from '@prisma/client';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CreateWorkspaceSchema, type CreateWorkspaceInput } from './workspace.schemas';
import { WorkspaceService } from './workspace.service';

@ApiTags('Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get(':enrollmentId')
  get(@Param('enrollmentId') enrollmentId: string, @Req() request: AuthenticatedRequest): Promise<Workspace> {
    return this.workspaceService.getForEnrollment(request.auth!.userId, enrollmentId);
  }

  @Post()
  @HttpCode(202)
  @UsePipes(new ZodValidationPipe(CreateWorkspaceSchema))
  create(@Body() body: CreateWorkspaceInput, @Req() request: AuthenticatedRequest): Promise<Workspace> {
    return this.workspaceService.create(request.auth!.userId, body.enrollmentId);
  }
}
```

- [ ] **Step 5: 实现 `src/workspace/workspace.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabsClient } from './labs-client';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceGateway } from './workspace.gateway';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [AuthModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, WorkspaceGateway, LabsClient],
})
export class WorkspaceModule {}
```

- [ ] **Step 6: 在 `src/app.module.ts` 注册**

```typescript
import { WorkspaceModule } from './workspace/workspace.module';
```

加进 `imports` 数组（跟在 `DashboardModule` 后面）：

```typescript
    DashboardModule,
    WorkspaceModule,
```

- [ ] **Step 7: 跑测试，确认通过**

Run: `npm test -- workspace`
Expected: PASS（`labs-client`、`workspace.gateway`、`workspace.service`、`workspace.controller` 全过）

- [ ] **Step 8: 跑全量测试和类型检查，确认没有破坏别的模块**

Run: `npm test && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 9: Commit**

```bash
git add src/workspace/workspace.schemas.ts src/workspace/workspace.controller.ts src/workspace/workspace.controller.spec.ts src/workspace/workspace.module.ts src/app.module.ts
git commit -m "feat: add WorkspaceController and wire WorkspaceModule into AppModule"
```

---

## Part B — Client（`aivirteach-client`）

> **前置条件**：Part A 已经部署到 Vercel，并且 Cloudflare Tunnel/Access 已经按 Part A Task 1 的部署清单配置
> 好——这几步需要真实打通 `GET/POST /workspaces` 到真实 Labs 才能手动验证。
>
> 这个仓库现有的测试是 `npm test`（构建后跑 `tests/rendered-html.test.mjs` 做未登录状态下的 SSR 冒烟测试，
> 不是针对单个函数的单元测试框架），所以 Part B 的任务不写新的单元测试文件——跟随现有约定，每个任务用
> `npm run build`（含 `tsc` 类型检查）+ `npm test` 确认没有破坏冒烟测试，最后手动过一遍真实流程。

### Task 5: `api.ts` 新增 `workspace` / `createWorkspace` 和 `getAccessToken`

**Files:**
- Modify: `app/lib/api.ts`

**Interfaces:**
- Produces:
  - `export type ApiWorkspace = { id: string; enrollmentId: string; status: "CREATING" | "RUNNING" | "STOPPED" | "ERROR" | "RESETTING" | "DESTROYED"; errorMessage: string | null }`
  - `api.workspace(enrollmentId: string): Promise<ApiWorkspace>`（404 时抛 `ApiError(404, ...)`）
  - `api.createWorkspace(enrollmentId: string): Promise<ApiWorkspace>`
  - `export function getAccessToken(): string | null`

- [ ] **Step 1: 加 `ApiWorkspace` 类型**

在 `app/lib/api.ts` 里 `ApiChatMessage` 类型定义附近加：

```typescript
export type ApiWorkspace = {
  id: string;
  enrollmentId: string;
  status: "CREATING" | "RUNNING" | "STOPPED" | "ERROR" | "RESETTING" | "DESTROYED";
  errorMessage: string | null;
};
```

- [ ] **Step 2: 导出 `getAccessToken`**

在 `hasAuthSession` 函数后面加：

```typescript
export function getAccessToken(): string | null {
  return readSession()?.accessToken ?? null;
}
```

- [ ] **Step 3: 在 `api` 对象里加两个方法**

在 `export const api = {` 里 `sendChatMessage` 那行后面加：

```typescript
  workspace: (enrollmentId: string) => request<ApiWorkspace>("/workspaces/" + encodeURIComponent(enrollmentId)),
  createWorkspace: (enrollmentId: string) => request<ApiWorkspace>("/workspaces", { method: "POST", body: JSON.stringify({ enrollmentId }) }),
```

- [ ] **Step 4: 类型检查确认没有破坏别的地方**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add app/lib/api.ts
git commit -m "feat: add workspace API calls and getAccessToken to api.ts"
```

---

### Task 6: `app/lib/ws.ts` — WebSocket 客户端封装

**Files:**
- Create: `app/lib/ws.ts`

**Interfaces:**
- Consumes: `getAccessToken()`、`API_BASE_URL`（Task 5、`app/lib/config.ts`，均已存在）
- Produces: `subscribeWorkspace(enrollmentId: string, onStatus: (workspace: ApiWorkspace) => void): () => void`
  （返回值是取消订阅函数）

- [ ] **Step 1: 实现 `app/lib/ws.ts`**

```typescript
import { API_BASE_URL } from "./config";
import { getAccessToken, type ApiWorkspace } from "./api";

type WorkspaceStatusMessage = { type: "workspace.status"; workspace: ApiWorkspace };

export function subscribeWorkspace(enrollmentId: string, onStatus: (workspace: ApiWorkspace) => void): () => void {
  const url = new URL(API_BASE_URL.replace(/^http/, "ws") + "/workspaces/socket");
  const token = getAccessToken();
  if (token) url.searchParams.set("token", token);
  url.searchParams.set("enrollmentId", enrollmentId);

  const socket = new WebSocket(url.toString());
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data as string) as WorkspaceStatusMessage;
      if (message.type === "workspace.status") onStatus(message.workspace);
    } catch {
      // 忽略解析不了的消息
    }
  };

  return () => socket.close();
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add app/lib/ws.ts
git commit -m "feat: add subscribeWorkspace WebSocket client helper"
```

---

### Task 7: `workspace/page.tsx` — 接入创建流程和状态展示

**Files:**
- Modify: `app/workspace/page.tsx`

- [ ] **Step 1: 加 import 和 state**

把：

```typescript
import { api, type ApiCourseDetail, type ApiEnrollment, type ApiLesson } from "../lib/api";
```

改成：

```typescript
import { api, ApiError, type ApiCourseDetail, type ApiEnrollment, type ApiLesson, type ApiWorkspace } from "../lib/api";
import { subscribeWorkspace } from "../lib/ws";
```

在 `const [enrollment, setEnrollment] = useState<ApiEnrollment | null>(null);` 后面加：

```typescript
  const [workspace, setWorkspace] = useState<ApiWorkspace | null>(null);
```

- [ ] **Step 2: 加创建 + 订阅的 `useEffect`**

在现有加载课程数据的 `useEffect`（依赖数组是 `[]` 那个）后面加一个新的：

```typescript
  useEffect(() => {
    if (!enrollment) return;
    let active = true;
    let unsubscribe: (() => void) | null = null;

    async function ensureWorkspace() {
      let current: ApiWorkspace;
      try {
        current = await api.workspace(enrollment!.id);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 404) throw caught;
        current = await api.createWorkspace(enrollment!.id);
      }
      if (!active) return;
      setWorkspace(current);
      unsubscribe = subscribeWorkspace(enrollment!.id, (updated) => { if (active) setWorkspace(updated); });
    }

    ensureWorkspace().catch((caught) => {
      if (active) setContentError(caught instanceof Error ? caught.message : "Could not prepare the workspace.");
    });

    return () => { active = false; unsubscribe?.(); };
  }, [enrollment]);
```

- [ ] **Step 3: 加重试函数**

在 `refreshTutor` 函数后面加：

```typescript
  function retryWorkspace() {
    if (!enrollment) return;
    void api.createWorkspace(enrollment.id).then(setWorkspace).catch((caught) => {
      setContentError(caught instanceof Error ? caught.message : "Could not restart the workspace.");
    });
  }
```

- [ ] **Step 4: 用 workspace 状态控制 VM 区域渲染**

把：

```tsx
        <main className="lab-workspace vm-workspace">
          <header className="vm-toolbar"><div><span className="vm-status-dot" aria-hidden="true" /><strong>Learning VM</strong></div><small>{vmUrl ? "Connected workspace" : "Awaiting connection"}</small></header>
          {vmUrl ? <iframe className="vm-frame" src={vmUrl} title="Interactive learning virtual machine" allow="clipboard-read; clipboard-write; fullscreen" /> : <section className="vm-empty-state" role="status"><span className="vm-display-icon" aria-hidden="true" /><h2>Learning VM</h2><p>The VM interface will appear here when a workspace URL is connected.</p></section>}
        </main>
```

改成：

```tsx
        <main className="lab-workspace vm-workspace">
          <header className="vm-toolbar"><div><span className="vm-status-dot" aria-hidden="true" /><strong>Learning VM</strong></div><small>{workspace?.status === "RUNNING" && vmUrl ? "Connected workspace" : "Awaiting connection"}</small></header>
          {workspace?.status === "RUNNING" && vmUrl ? (
            <iframe className="vm-frame" src={vmUrl} title="Interactive learning virtual machine" allow="clipboard-read; clipboard-write; fullscreen" />
          ) : workspace?.status === "ERROR" ? (
            <section className="vm-empty-state" role="status">
              <span className="vm-display-icon" aria-hidden="true" />
              <h2>Learning VM</h2>
              <p>{workspace.errorMessage || "Could not start your Learning VM."}</p>
              <button className="primary-button" type="button" onClick={retryWorkspace}>Retry</button>
            </section>
          ) : (
            <section className="vm-empty-state" role="status">
              <span className="vm-display-icon" aria-hidden="true" />
              <h2>Learning VM</h2>
              <p>Preparing your Learning VM. This can take a few minutes.</p>
            </section>
          )}
        </main>
```

- [ ] **Step 5: 构建 + 冒烟测试确认没破坏现有页面**

Run: `npm run build && npm test`
Expected: 全部 PASS（包括 `renders /workspace` 那条——未登录状态下 `enrollment` 一直是 `null`，新加的
`useEffect` 不会触发，跟改之前行为一致）

- [ ] **Step 6: 手动验证（需要真实登录 + Part A 已部署 + Labs 可达）**

浏览器登录 → 报名一门课程 → 走完 `/courses/welcome` → 落地 `/workspace`：
- 应该看到"Preparing your Learning VM"
- Labs 建完 VM 后（最长几分钟），页面应该自动变化（WebSocket 推送生效，不用手动刷新）
- 如果配置了 `NEXT_PUBLIC_LEARNING_VM_URL`，状态变 RUNNING 后应该看到 iframe

- [ ] **Step 7: Commit**

```bash
git add app/workspace/page.tsx
git commit -m "feat: trigger workspace creation and show live status on /workspace"
```

---

## Self-Review 记录

- **Spec coverage**：架构（Part A 四个组件）、数据流（Task 3+4 的 create/get 顺序）、错误处理（Task 3 的
  stale reconciliation + Task 7 的 retry 按钮）、测试（每个 server task 自带单测；client 部分明确改用现有
  冒烟测试 + 手动验证，理由写在 Part B 前言里）全部有对应任务覆盖。部署清单是纯配置工作，不产出代码，本
  plan 不含对应任务，仍然只在 spec 里。
- **实现时发现并修正的 spec 偏差**：spec 原文写"成功 → 更新行（status=RUNNING, ip/rdpPort/vncPort/labId）"，
  但 Labs `POST /v1/vms` 的真实响应里没有 `ip`/`vnc_port` 字段（要另外调 `GET .../ip`、`GET .../vnc`），这次
  没有代码路径用到这两个值，所以计划里 `ip`/`vncPort` 不写，只写 `labId`/`rdpUsername`/`rdpPort`——已经在
  Global Constraints 里记录原因，避免以后看这份 plan 的人以为是遗漏。
- **Placeholder scan**：无 TBD/TODO，无"add proper error handling"这类空话，每个 Step 都是完整代码或精确命令。
- **Type consistency**：`LabsClient.createVm` 返回 `{labId, username, rdpPort}` → `WorkspaceService.provisionInBackground`
  按同样的字段名读取 → `Workspace.rdpUsername`/`Workspace.rdpPort` 是 schema 里的实际字段名，三处一致。
  `ApiWorkspace.status` 的联合类型跟 Prisma `WorkspaceStatus` 枚举的 6 个值一一对应。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-22-workspace-vm-orchestration.md`. Two execution options:

1. **Subagent-Driven（推荐）** — 每个 task 派一个新 subagent，task 之间做审查，迭代更快
2. **Inline Execution** — 在当前会话里按 executing-plans 批量执行，设检查点审查

想用哪种？
