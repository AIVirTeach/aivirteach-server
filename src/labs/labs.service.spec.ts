import { HEADERS_METADATA } from "@nestjs/common/constants";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { LabsController } from "./labs.controller";
import { LabsService } from "./labs.service";

describe("LabsService", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    process.env.LEARNER_LAB_MAP = JSON.stringify({ learner_advanced: "lab-001" });
    process.env.LABS_API_BASE_URL = "http://127.0.0.1:8760";
    process.env.LABS_SESSION_TOKEN = "session-token";
    process.env.GUACAMOLE_PUBLIC_PATH = "/guacamole/";
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterAll(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  it("requests only the current learner's mapped lab and returns an opaque embed URL", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      lab_id: "lab-001",
      state: "ready",
      data: "opaque+/=ticket",
      expires_at: 1_800_000_000_000,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await new LabsService().createBrowserSession("learner_advanced");

    expect(result).toEqual({
      state: "ready",
      embedUrl: "/guacamole/?data=opaque%2B%2F%3Dticket",
      expiresAt: 1_800_000_000_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8760/v1/vms/lab-001/browser-sessions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "learner_advanced" }),
      }),
    );
  });

  it("normalizes a starting Labs response for client polling", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ lab_id: "lab-001", state: "starting" }), { status: 200 }));

    await expect(new LabsService().createBrowserSession("learner_advanced")).resolves.toEqual({
      state: "starting",
      retryAfterMs: 2500,
    });
  });

  it("does not poll forever when Labs reports an unavailable VM state", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ lab_id: "lab-001", state: "paused" }), { status: 200 }));

    await expect(new LabsService().createBrowserSession("learner_advanced")).rejects.toThrow("not available");
  });

  it("does not call Labs for an unmapped learner", async () => {
    await expect(new LabsService().createBrowserSession("learner_beginner")).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid mapping configuration before making a request", async () => {
    process.env.LEARNER_LAB_MAP = JSON.stringify({ learner_advanced: "not a valid lab" });

    await expect(new LabsService().createBrowserSession("learner_advanced")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed ready responses without exposing their contents", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      lab_id: "lab-001",
      state: "ready",
      data: "",
      expires_at: null,
    }), { status: 200 }));

    await expect(new LabsService().createBrowserSession("learner_advanced")).rejects.toThrow("invalid browser session");
  });

  it("normalizes a non-object Labs response as an unavailable dependency", async () => {
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }));

    await expect(new LabsService().createBrowserSession("learner_advanced")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("marks the public session endpoint as non-cacheable", () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, LabsController.prototype.createSession) as Array<{ name: string; value: string }>;
    expect(headers).toContainEqual({ name: "Cache-Control", value: "private, no-store" });
  });
});
