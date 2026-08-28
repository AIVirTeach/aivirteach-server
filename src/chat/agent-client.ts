import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';

export type DiagnoseRequestBody = {
  request_id: string;
  lab_id: string;
  question: string;
  course: {
    course_id: string;
    version: number;
    title: string;
    summary: string;
  };
  current_step: {
    module_id: string;
    lesson_id: string;
    sequence: number;
    title: string;
    instructions: string[];
    expected_result: string;
    success_criteria: string[];
    common_failures: Array<{ code: string; symptoms: string[] }>;
  };
};

// Labs 是外部服务，quick tunnel 地址还会变——2xx 不代表 body 形状可信，运行时必须校验
// （不能只靠 TypeScript 的编译期类型断言），否则 answer 缺失会导致 ChatService 写 Conversation
// 时因 content 非空约束抛出未捕获异常，变成 500，违反"聊天接口不返回 5xx"的设计约束。
const DiagnoseResponseSchema = z.object({
  request_id: z.string(),
  status: z.enum(['completed', 'partial']),
  answer: z.string().min(1),
  diagnosis: z.unknown(),
  course_alignment: z.unknown(),
  evidence: z.array(z.unknown()),
  suggested_actions: z.array(z.unknown()),
  limitations: z.array(z.string()),
  tool_trace: z.array(z.unknown()),
});

export type DiagnoseResponseBody = z.infer<typeof DiagnoseResponseSchema>;

// 这次连通性测试（真实 DeepSeek 调用 + 工具查证）耗时在十几秒量级，60 秒留够余量。
const DIAGNOSE_TIMEOUT_MS = 60_000;

@Injectable()
export class AgentClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async diagnose(payload: DiagnoseRequestBody): Promise<DiagnoseResponseBody> {
    const { LABS_AGENT_BASE_URL, AIVIRTEACH_AGENT_TOKEN } = this.env;
    if (!LABS_AGENT_BASE_URL || !AIVIRTEACH_AGENT_TOKEN) {
      throw new ServiceUnavailableException('Agent 集成未配置：缺少 LABS_AGENT_BASE_URL 或 AIVIRTEACH_AGENT_TOKEN');
    }

    const response = await fetch(`${LABS_AGENT_BASE_URL}/v1/agent/diagnose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AIVIRTEACH_AGENT_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Agent 诊断失败（${response.status}）：${detail || response.statusText}`);
    }

    const parsed = DiagnoseResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`Agent 响应格式不符合预期：${parsed.error.message}`);
    }
    return parsed.data;
  }
}
