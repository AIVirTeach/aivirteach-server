import { Test } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AgentClient, type DiagnoseRequestBody } from './agent-client';

const BASE_ENV: Env = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'x'.repeat(32),
  ADMIN_API_TOKEN: 't'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  OPERATOR_SESSION_TTL: '8h',
  REFRESH_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  PORT: 4000,
  CORS_ORIGINS: 'http://localhost:3001',
  WORKSPACE_IDLE_TIMEOUT_MINUTES: 15,
  TOKEN_QUOTA_ENFORCED: false,
  TOKEN_WEIGHT_CACHE_HIT: 0.02,
  TOKEN_WEIGHT_INPUT_MISS: 1,
  TOKEN_WEIGHT_OUTPUT: 4,
};

const PAYLOAD: DiagnoseRequestBody = {
  request_id: '11111111-1111-4111-8111-111111111111',
  lab_id: 'workspace_1',
  question: 'docker install 卡住了',
  course: {
    course_id: 'linux-basics',
    version: 1,
    title: 'Linux 基础',
    summary: '',
  },
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
    providers: [
      AgentClient,
      { provide: ENV, useValue: { ...BASE_ENV, ...envOverrides } },
    ],
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
    await expect(client.diagnose(PAYLOAD)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('POST /v1/agent/diagnose，带 bearer token，原样透传 payload，解析成功响应', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
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
    global.fetch = fetchMock;

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
      json: () =>
        Promise.resolve({
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
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    const result = await client.diagnose(PAYLOAD);

    expect(result.status).toBe('partial');
    expect(result.limitations).toEqual(['GATEWAY_UNAVAILABLE']);
  });

  it('Agent 返回 401（权限/配置问题）时提示联系客服，不透出原始响应内容', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('Invalid or missing bearer token.'),
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'wrong-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow(
      '助教服务暂时不可用，请联系客服。',
    );
  });

  it('Agent 返回 5xx（瞬时性问题）时提示重试', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('Agent dependencies are not configured.'),
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow(
      '助教暂时没有回应，请重试一次。',
    );
  });

  it('网络层失败（fetch 本身 reject）时提示重试', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted.', 'AbortError'),
      );

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow(
      '助教暂时没有回应，请重试一次。',
    );
  });

  it('Agent 返回 2xx 但响应体缺少必填字段（如 answer）时抛出错误，不会返回半成品对象', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          request_id: PAYLOAD.request_id,
          status: 'completed',
          diagnosis: {},
          course_alignment: {},
          evidence: [],
          suggested_actions: [],
          limitations: [],
          tool_trace: [],
        }),
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow(
      'Agent 响应格式不符合预期',
    );
  });

  it('Agent 返回 2xx 但 body 不是对象（如 null）时抛出错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(client.diagnose(PAYLOAD)).rejects.toThrow(
      'Agent 响应格式不符合预期',
    );
  });
});

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
}

describe('AgentClient.diagnoseStream', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('缺少 LABS_AGENT_BASE_URL 或 AIVIRTEACH_AGENT_TOKEN 时抛出 ServiceUnavailableException', async () => {
    const client = await buildClient({});
    await expect(
      collect(client.diagnoseStream(PAYLOAD)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('POST /v1/agent/diagnose/stream，带 bearer token，原样透传 payload，逐帧解析 SSE body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: streamFromText(
        'event: reasoning_started\ndata: {"turn":1}\n\nevent: result\ndata: {"response":{}}\n\n',
      ),
    });
    global.fetch = fetchMock;

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    const frames = await collect(client.diagnoseStream(PAYLOAD));

    expect(frames).toEqual([
      { event: 'reasoning_started', data: '{"turn":1}' },
      { event: 'result', data: '{"response":{}}' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://labs-agent.example.com/v1/agent/diagnose/stream',
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

  it('Agent 返回 5xx（瞬时性问题）时提示重试', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('Agent dependencies are not configured.'),
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(collect(client.diagnoseStream(PAYLOAD))).rejects.toThrow(
      '助教暂时没有回应，请重试一次。',
    );
  });

  it('Agent 返回 401（权限/配置问题）时提示联系客服', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('Invalid or missing bearer token.'),
    });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'wrong-token',
    });

    await expect(collect(client.diagnoseStream(PAYLOAD))).rejects.toThrow(
      '助教服务暂时不可用，请联系客服。',
    );
  });

  it('网络层失败（fetch 本身 reject）时提示重试', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted.', 'AbortError'),
      );

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(collect(client.diagnoseStream(PAYLOAD))).rejects.toThrow(
      '助教暂时没有回应，请重试一次。',
    );
  });

  it('Agent 返回 2xx 但没有 body 时抛出错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: null });

    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });

    await expect(collect(client.diagnoseStream(PAYLOAD))).rejects.toThrow(
      'Agent 响应没有 body',
    );
  });
});

describe('AgentClient.diagnose — usage', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const BASE_RESPONSE = {
    request_id: PAYLOAD.request_id,
    status: 'completed',
    answer: '试试重启 docker 服务。',
    diagnosis: {},
    course_alignment: {},
    evidence: [],
    suggested_actions: [],
    limitations: [],
    tool_trace: [],
  };

  async function diagnoseWith(body: Record<string, unknown>) {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
    const client = await buildClient({
      LABS_AGENT_BASE_URL: 'https://labs-agent.example.com',
      AIVIRTEACH_AGENT_TOKEN: 'agent-token',
    });
    return client.diagnose(PAYLOAD);
  }

  it('解析 Labs 返回的三类 token usage', async () => {
    const usage = {
      input_cache_hit_tokens: 1000,
      input_cache_miss_tokens: 200,
      output_tokens: 50,
    };
    const result = await diagnoseWith({ ...BASE_RESPONSE, usage });
    expect(result.usage).toEqual(usage);
  });

  it('Labs 还没部署新版本、响应里没有 usage 时照常解析（向后兼容）', async () => {
    const result = await diagnoseWith(BASE_RESPONSE);
    expect(result.answer).toBe(BASE_RESPONSE.answer);
    expect(result.usage).toBeUndefined();
  });

  it('usage 为 null 时照常解析', async () => {
    const result = await diagnoseWith({ ...BASE_RESPONSE, usage: null });
    expect(result.answer).toBe(BASE_RESPONSE.answer);
    expect(result.usage ?? null).toBeNull();
  });

  it.each([
    [
      '负数',
      {
        input_cache_hit_tokens: -1,
        input_cache_miss_tokens: 0,
        output_tokens: 0,
      },
    ],
    [
      '非整数',
      {
        input_cache_hit_tokens: 1.5,
        input_cache_miss_tokens: 0,
        output_tokens: 0,
      },
    ],
    [
      '字符串',
      {
        input_cache_hit_tokens: '10',
        input_cache_miss_tokens: 0,
        output_tokens: 0,
      },
    ],
    ['缺字段', { input_cache_hit_tokens: 10 }],
  ])(
    'usage 格式非法（%s）时丢弃 usage，但不能让整个诊断响应失败',
    async (_label, usage) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const result = await diagnoseWith({ ...BASE_RESPONSE, usage });
      expect(result.answer).toBe(BASE_RESPONSE.answer);
      expect(result.usage).toBeUndefined();
      // 丢弃不能是静默的：Labs 改了协议时，靠这条日志才能第一时间发现计量停了。
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('usage 格式非法'),
      );
    },
  );
});
