import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import { classifyUpstreamStatus, type UpstreamErrorMessages } from '../common/upstream-error';
import { parseSseStream, type SseFrame } from './sse-parser';

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
export const DiagnoseResponseSchema = z.object({
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

// 面向学生的文案，按"重试是否有用"分两档，不透出任何上游响应内容或内部服务名——
// 具体原因只进服务端日志，见 AgentClient.assertOk() / AgentClient.logNetworkFailure()。
// ChatService 目前会再兜一层固定文案，这里的分档是防御性的第二道防线。
const AGENT_MESSAGES: UpstreamErrorMessages = {
  retryable: '助教暂时没有回应，请重试一次。',
  unavailable: '助教服务暂时不可用，请联系客服。',
};

@Injectable()
export class AgentClient {
  private readonly logger = new Logger(AgentClient.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  // response.ok 为 false 时：原始响应体只记日志，抛给调用方的 Error 只带分档后的安全文案。
  private async assertOk(response: Response, context: string): Promise<void> {
    if (response.ok) return;
    const detail = await response.text().catch(() => '');
    this.logger.error(`${context} 失败（${response.status}）：${(detail || response.statusText).slice(0, 2000)}`);
    throw new Error(AGENT_MESSAGES[classifyUpstreamStatus(response.status)]);
  }

  // fetch() 本身 reject（DNS 失败、超时、连接被拒……）拿不到 response，本质都是瞬时性问题，
  // 直接用 retryable，不需要走 classifyUpstreamStatus。
  private logNetworkFailure(context: string, error: unknown): never {
    this.logger.error(`${context} 网络请求失败`, error instanceof Error ? error.stack : String(error));
    throw new Error(AGENT_MESSAGES.retryable);
  }

  async diagnose(payload: DiagnoseRequestBody): Promise<DiagnoseResponseBody> {
    const { LABS_AGENT_BASE_URL, AIVIRTEACH_AGENT_TOKEN } = this.env;
    if (!LABS_AGENT_BASE_URL || !AIVIRTEACH_AGENT_TOKEN) {
      throw new ServiceUnavailableException('Agent 集成未配置：缺少 LABS_AGENT_BASE_URL 或 AIVIRTEACH_AGENT_TOKEN');
    }

    let response: Response;
    try {
      response = await fetch(`${LABS_AGENT_BASE_URL}/v1/agent/diagnose`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AIVIRTEACH_AGENT_TOKEN}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logNetworkFailure('diagnose', error);
    }
    await this.assertOk(response, 'diagnose');

    const parsed = DiagnoseResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`Agent 响应格式不符合预期：${parsed.error.message}`);
    }
    return parsed.data;
  }

  // 不设超时：labs 的 SSE_HEARTBEAT_SECONDS 心跳负责保活，orchestrator 自己的
  // total_timeout_seconds 负责兜底——套用 diagnose() 那个 60s 上限会掐断本该更长的合法诊断流。
  async *diagnoseStream(payload: DiagnoseRequestBody): AsyncGenerator<SseFrame> {
    const { LABS_AGENT_BASE_URL, AIVIRTEACH_AGENT_TOKEN } = this.env;
    if (!LABS_AGENT_BASE_URL || !AIVIRTEACH_AGENT_TOKEN) {
      throw new ServiceUnavailableException('Agent 集成未配置：缺少 LABS_AGENT_BASE_URL 或 AIVIRTEACH_AGENT_TOKEN');
    }

    let response: Response;
    try {
      response = await fetch(`${LABS_AGENT_BASE_URL}/v1/agent/diagnose/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AIVIRTEACH_AGENT_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.logNetworkFailure('diagnoseStream', error);
    }
    await this.assertOk(response, 'diagnoseStream');

    if (!response.body) {
      throw new Error('Agent 响应没有 body，无法读取 SSE 流');
    }

    yield* parseSseStream(response.body);
  }
}
