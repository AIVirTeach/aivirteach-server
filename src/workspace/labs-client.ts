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

export type VmCredentials = {
  password: string;
};

type CredentialsResponseBody = {
  password: string;
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
}
