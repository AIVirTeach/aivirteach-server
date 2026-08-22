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
