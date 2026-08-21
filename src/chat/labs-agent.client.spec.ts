import { BadGatewayException, ServiceUnavailableException } from "@nestjs/common";
import { LabsAgentClient, LabsAgentRequest } from "./labs-agent.client";

describe("LabsAgentClient", () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    LABS_AGENT_BASE_URL: process.env.LABS_AGENT_BASE_URL,
    LABS_AGENT_TOKEN: process.env.LABS_AGENT_TOKEN,
    LABS_AGENT_TIMEOUT_MS: process.env.LABS_AGENT_TIMEOUT_MS,
  };
  let fetchMock: jest.MockedFunction<typeof fetch>;

  const request = (): LabsAgentRequest => ({
    request_id: "a10beac8-d1db-4b1a-8df0-79aa8208e273",
    lab_id: "lab-001",
    question: "n8n 为什么打不开？",
    response_language: "zh-CN",
    course: { course_id: "ai-daily-briefing", version: 1, title: "AI Daily Briefing", summary: "" },
    current_step: {
      module_id: "runtime-environment",
      lesson_id: "install-n8n",
      sequence: 4,
      title: "Install and Start n8n",
      summary: "",
      instructions: [],
      expected_result: "n8n opens",
      success_criteria: [],
    },
    learner_state: {},
    history: [],
    diagnostic_scope: {
      workspace_root: "/home/learner/course",
      allowed_tools: ["get_vm_status"],
      allowed_relative_paths: [],
      allowed_services: [],
      allowed_containers: [],
      allowed_ports: [],
      allowed_external_hosts: [],
      allowed_runtimes: [],
    },
  });

  beforeEach(() => {
    process.env.LABS_AGENT_BASE_URL = "http://127.0.0.1:8770";
    process.env.LABS_AGENT_TOKEN = "agent-token";
    process.env.LABS_AGENT_TIMEOUT_MS = "45000";
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("calls the private Agent endpoint with its server-side bearer token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      request_id: request().request_id,
      status: "completed",
      answer: "  n8n 容器没有运行。  ",
      diagnosis: {},
      course_alignment: {},
      evidence: [],
      suggested_actions: [],
      limitations: [],
      tool_trace: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(new LabsAgentClient().diagnose(request())).resolves.toEqual({
      status: "completed",
      answer: "n8n 容器没有运行。",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8770/v1/agent/diagnose",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer agent-token", "Content-Type": "application/json" },
        body: JSON.stringify(request()),
      }),
    );
  });

  it("maps an Agent network failure to a safe 503 without leaking error details", async () => {
    fetchMock.mockRejectedValue(new Error("connection failed with agent-token"));

    let caught: unknown;
    try {
      await new LabsAgentClient().diagnose(request());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(String((caught as Error).message)).not.toContain("agent-token");
  });

  it("maps a rejected request to a safe 502 without returning the upstream body", async () => {
    fetchMock.mockResolvedValue(new Response("upstream secret: agent-token", { status: 401 }));

    let caught: unknown;
    try {
      await new LabsAgentClient().diagnose(request());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadGatewayException);
    expect(String((caught as Error).message)).not.toContain("agent-token");
  });

  it("rejects a mismatched response request ID as a bad gateway response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      request_id: "b89d5baf-52a2-4dd5-a2fe-5b3c3d3c93e5",
      status: "completed",
      answer: "answer",
    }), { status: 200 }));

    await expect(new LabsAgentClient().diagnose(request())).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("rejects unsafe timeout configuration before making a request", async () => {
    process.env.LABS_AGENT_TIMEOUT_MS = "0";

    await expect(new LabsAgentClient().diagnose(request())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
