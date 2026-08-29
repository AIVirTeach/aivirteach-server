import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AgentClient, type DiagnoseRequestBody } from './agent-client';

const BASE_ENV: Env = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'x'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 4000,
  CORS_ORIGINS: 'http://localhost:3001',
};

const PAYLOAD: DiagnoseRequestBody = {
  request_id: '11111111-1111-4111-8111-111111111111',
  lab_id: 'workspace_1',
  question: 'docker install 卡住了',
  course: { course_id: 'linux-basics', version: 1, title: 'Linux 基础', summary: '' },
  current_step: {
    module_id: 'module_1',
    lesson_id: 'verify-virtual-machine',
    sequence: 1,
    title: '验证虚拟机',
    instructions: ['打开终端', '运行 docker --version'],
    expected_result: '',
    success_criteria: [],
    common_failures: [],
  },
};

async function buildClient(envOverrides: Partial<Env>) {
  const moduleRef = await Test.createTestingModule({
    providers: [AgentClient, { provide: ENV, useValue: { ...BASE_ENV, ...envOverrides } }],
  }).compile();
  return moduleRef.get(AgentClient);
}

describe('AgentClient.diagnose', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('缺少 LABS_AGENT_BASE_URL 或 AIVIRTEACH_AGENT_TOKEN 时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({});
    await expect(client.diagnose(PAYLOAD)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('POST /v1/agent/diagnose，带 bearer token，原样透传 payload，解析成功响应', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        request_id: PAYLOAD.request_id,
        status: 'completed',
        answer: '看起来是网络问题，试试重启 docker 服务。',
        diagnosis: {},
        course_alignment: {},
        evidence: [],
        suggested_actions: [],
        limitations: [],
        tool_trace: [],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    const result = await client.diagnose(PAYLOAD);

    expect(result.status).toBe('completed');
    expect(result.answer).toContain('docker');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-agent.example.com/v1/agent/diagnose',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer agent-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(PAYLOAD),
      }),
    );
  });

  it('status: "partial" 也正常解析，不当错误处理', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        request_id: PAYLOAD.request_id,
        status: 'partial',
        answer: '工具调用失败，但根据已知信息给出回答。',
        diagnosis: {},
        course_alignment: {},
        evidence: [],
        suggested_actions: [],
        limitations: ['GATEWAY_UNAVAILABLE'],
        tool_trace: [],
      }),
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    const result = await client.diagnose(PAYLOAD);

    expect(result.status).toBe('partial');
    expect(result.limitations).toEqual(['GATEWAY_UNAVAILABLE']);
  });

  it('Agent 返回非 2xx 时抛出带状态码和详情的错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid or missing bearer token.',
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'wrong-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow(
      'Agent 诊断失败（401）：Invalid or missing bearer token.',
    );
  });

  it('Agent 返回 2xx 但响应体缺少必填字段（如 answer）时抛出错误，不会返回半成品对象', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        request_id: PAYLOAD.request_id,
        status: 'completed',
        diagnosis: {},
        course_alignment: {},
        evidence: [],
        suggested_actions: [],
        limitations: [],
        tool_trace: [],
      }),
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow('Agent 响应格式不符合预期');
  });

  it('Agent 返回 2xx 但 body 不是对象（如 null）时抛出错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    }) as unknown as typeof fetch;

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow('Agent 响应格式不符合预期');
  });
});
