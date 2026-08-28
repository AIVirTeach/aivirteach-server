import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
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

export type DiagnoseResponseBody = {
  request_id: string;
  status: 'completed' | 'partial';
  answer: string;
  diagnosis: unknown;
  course_alignment: unknown;
  evidence: unknown[];
  suggested_actions: unknown[];
  limitations: string[];
  tool_trace: unknown[];
};

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

    return (await response.json()) as DiagnoseResponseBody;
  }
}
