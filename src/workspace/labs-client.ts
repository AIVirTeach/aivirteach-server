import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { classifyUpstreamStatus, type UpstreamErrorMessages } from '../common/upstream-error';

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

export type GuacamoleToken = {
  authToken: string;
  websocketUrl: string;
};

type GuacamoleTokenResponseBody = {
  authToken: string;
};

// Labs 的 POST /v1/vms 最长阻塞 180 秒（CREATE_TIMEOUT_SECONDS），留够余量。
const CREATE_VM_TIMEOUT_MS = 200_000;

// 面向学生的文案，按"重试是否有用"分两档，不透出任何上游响应内容或内部服务名——
// 具体原因只进服务端日志，见 LabsClient.assertOk() / LabsClient.logNetworkFailure()。
const VM_MESSAGES: UpstreamErrorMessages = {
  retryable: '学习环境暂时连接不上，请稍后重试。',
  unavailable: '学习环境暂时无法使用，请稍后再试或联系客服。',
};
const REMOTE_DESKTOP_MESSAGES: UpstreamErrorMessages = {
  retryable: '远程桌面连接失败，请稍后重试。',
  unavailable: '远程桌面暂时无法使用，请联系客服。',
};

@Injectable()
export class LabsClient {
  private readonly logger = new Logger(LabsClient.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  // response.ok 为 false 时：原始响应体只记日志（可能是 Cloudflare tunnel 挂了之类的
  // 整页 HTML，见 2026-09-23 的 VM Manager 403 事故），抛给调用方的 Error 只带分档后的安全文案。
  private async assertOk(response: Response, context: string, messages: UpstreamErrorMessages): Promise<void> {
    if (response.ok) return;
    const detail = await response.text().catch(() => '');
    this.logger.error(`${context} 失败（${response.status}）：${(detail || response.statusText).slice(0, 2000)}`);
    throw new Error(messages[classifyUpstreamStatus(response.status)]);
  }

  // fetch() 本身 reject（DNS 失败、超时、连接被拒……）拿不到 response，本质都是瞬时性问题，
  // 直接用 messages.retryable，不需要走 classifyUpstreamStatus。
  private logNetworkFailure(context: string, error: unknown, messages: UpstreamErrorMessages): never {
    this.logger.error(`${context} 网络请求失败`, error instanceof Error ? error.stack : String(error));
    throw new Error(messages.retryable);
  }

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

    let response: Response;
    try {
      response = await fetch(`${LABS_VM_BASE_URL}/v1/vms`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ lab_id: labId }),
        signal: AbortSignal.timeout(CREATE_VM_TIMEOUT_MS),
      });
    } catch (error) {
      this.logNetworkFailure('createVm', error, VM_MESSAGES);
    }
    await this.assertOk(response, 'createVm', VM_MESSAGES);

    // rdp_password 故意不读取、不透出——这次不需要连接 VM，没必要提前经手一个不用的明文密钥，
    // 见本文档 Global Constraints。
    const body = (await response.json()) as CreateVmResponseBody;
    return { labId: body.lab_id, username: body.username, rdpPort: body.rdp_port };
  }

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

    let response: Response;
    try {
      response = await fetch(`${LABS_VM_BASE_URL}/v1/vms/${labId}/browser-sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ subject }),
      });
    } catch (error) {
      this.logNetworkFailure('createBrowserSession', error, REMOTE_DESKTOP_MESSAGES);
    }
    await this.assertOk(response, 'createBrowserSession', REMOTE_DESKTOP_MESSAGES);

    const body = (await response.json()) as BrowserSessionResponseBody;
    return {
      labId: body.lab_id,
      state: body.state,
      data: body.data,
      expiresAt: body.expires_at !== undefined ? new Date(body.expires_at).toISOString() : undefined,
    };
  }

  async stopVm(labId: string): Promise<void> {
    await this.runVmAction(labId, 'stop');
  }

  async startVm(labId: string): Promise<void> {
    await this.runVmAction(labId, 'start');
  }

  private async runVmAction(labId: string, action: 'stop' | 'start'): Promise<void> {
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

    let response: Response;
    try {
      response = await fetch(`${LABS_VM_BASE_URL}/v1/vms/${labId}/actions/${action}`, {
        method: 'POST',
        headers,
      });
    } catch (error) {
      this.logNetworkFailure(`runVmAction(${action})`, error, VM_MESSAGES);
    }
    await this.assertOk(response, `runVmAction(${action})`, VM_MESSAGES);
  }

  // 浏览器直接 fetch Guacamole 的 /api/tokens 会被 CORS 挡住（Guacamole 默认不带
  // Access-Control-Allow-Origin），这里改成 server 对 server 转发一次，规避这个限制，
  // 不需要同源反代也不需要 Guacamole 那边加 CORS 头。WebSocket tunnel 本身不受 CORS
  // 限制，浏览器拿到 authToken 后直接跨域连 websocketUrl。
  async exchangeGuacamoleToken(data: string): Promise<GuacamoleToken> {
    const { LABS_GUACAMOLE_BASE_URL } = this.env;
    if (!LABS_GUACAMOLE_BASE_URL) {
      throw new ServiceUnavailableException('Labs 集成未配置：缺少 LABS_GUACAMOLE_BASE_URL');
    }
    const base = LABS_GUACAMOLE_BASE_URL.endsWith('/') ? LABS_GUACAMOLE_BASE_URL : `${LABS_GUACAMOLE_BASE_URL}/`;

    let response: Response;
    try {
      response = await fetch(new URL('api/tokens', base).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data }),
      });
    } catch (error) {
      this.logNetworkFailure('exchangeGuacamoleToken', error, REMOTE_DESKTOP_MESSAGES);
    }
    await this.assertOk(response, 'exchangeGuacamoleToken', REMOTE_DESKTOP_MESSAGES);

    const body = (await response.json()) as GuacamoleTokenResponseBody;
    const websocketUrl = new URL('websocket-tunnel', base);
    websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    return { authToken: body.authToken, websocketUrl: websocketUrl.toString() };
  }
}
