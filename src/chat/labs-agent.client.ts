import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";

const DEFAULT_AGENT_BASE_URL = "http://127.0.0.1:8770";
const DEFAULT_AGENT_TIMEOUT_MS = 45_000;
const MIN_AGENT_TIMEOUT_MS = 1_000;
const MAX_AGENT_TIMEOUT_MS = 120_000;

export type LabsAgentHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LabsAgentRequest = {
  request_id: string;
  lab_id: string;
  question: string;
  response_language: string;
  course: {
    course_id: string;
    version: string | number;
    title: string;
    summary: string;
  };
  current_step: {
    module_id: string;
    lesson_id: string;
    sequence: number;
    title: string;
    summary: string;
    instructions: string[];
    expected_result: string;
    success_criteria: string[];
  };
  learner_state: Record<string, unknown>;
  history: LabsAgentHistoryMessage[];
  diagnostic_scope: {
    workspace_root: string;
    allowed_tools: string[];
    allowed_relative_paths: string[];
    allowed_services: string[];
    allowed_containers: string[];
    allowed_ports: number[];
    allowed_external_hosts: string[];
    allowed_runtimes: Array<"python" | "node">;
  };
};

export type LabsAgentResult = {
  status: "completed" | "partial";
  answer: string;
};

type UnknownAgentResponse = {
  request_id?: unknown;
  status?: unknown;
  answer?: unknown;
};

@Injectable()
export class LabsAgentClient {
  async diagnose(request: LabsAgentRequest): Promise<LabsAgentResult> {
    const token = process.env.LABS_AGENT_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException("LABS_AGENT_TOKEN is not configured");

    let response: Response;
    try {
      response = await fetch(this.agentUrl("/v1/agent/diagnose"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("The Labs Agent is unavailable or timed out");
    }

    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new ServiceUnavailableException("The Labs Agent is temporarily unavailable");
      }
      throw new BadGatewayException("The Labs Agent rejected the server diagnosis request");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BadGatewayException("The Labs Agent returned an invalid diagnosis response");
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new BadGatewayException("The Labs Agent returned an invalid diagnosis response");
    }
    const result = payload as UnknownAgentResponse;
    const answer = typeof result.answer === "string" ? result.answer.trim() : "";
    if (
      result.request_id !== request.request_id
      || (result.status !== "completed" && result.status !== "partial")
      || !answer
      || answer.length > 12_000
    ) {
      throw new BadGatewayException("The Labs Agent returned an invalid diagnosis response");
    }
    return { status: result.status, answer };
  }

  private agentUrl(path: string): string {
    const configured = (process.env.LABS_AGENT_BASE_URL ?? DEFAULT_AGENT_BASE_URL).trim().replace(/\/+$/, "");
    try {
      const url = new URL(configured + path);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
      return url.toString();
    } catch {
      throw new ServiceUnavailableException("LABS_AGENT_BASE_URL is invalid");
    }
  }

  private timeoutMs(): number {
    const configured = process.env.LABS_AGENT_TIMEOUT_MS?.trim();
    if (!configured) return DEFAULT_AGENT_TIMEOUT_MS;
    if (!/^\d+$/.test(configured)) throw new ServiceUnavailableException("LABS_AGENT_TIMEOUT_MS is invalid");
    const timeout = Number(configured);
    if (timeout < MIN_AGENT_TIMEOUT_MS || timeout > MAX_AGENT_TIMEOUT_MS) {
      throw new ServiceUnavailableException("LABS_AGENT_TIMEOUT_MS is invalid");
    }
    return timeout;
  }
}
