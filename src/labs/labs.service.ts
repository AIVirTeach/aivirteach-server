import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";

const LAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const DEFAULT_LABS_API_BASE_URL = "http://127.0.0.1:8760";
const DEFAULT_GUACAMOLE_PUBLIC_PATH = "/guacamole/";
const STARTING_RETRY_AFTER_MS = 2500;

type LabsBrowserSession = {
  lab_id?: unknown;
  state?: unknown;
  data?: unknown;
  expires_at?: unknown;
};

export type BrowserSessionResponse =
  | { state: "starting"; retryAfterMs: number }
  | { state: "ready"; embedUrl: string; expiresAt: number };

@Injectable()
export class LabsService {
  assignedLabId(userId: string): string {
    const labId = this.learnerLabMap().get(userId);
    if (!labId) throw new NotFoundException("No learning lab is assigned to this learner");
    return labId;
  }

  async createBrowserSession(userId: string): Promise<BrowserSessionResponse> {
    const labId = this.assignedLabId(userId);

    const session = await this.requestBrowserSession(labId, userId);
    if (session.state === "starting") {
      return { state: "starting", retryAfterMs: STARTING_RETRY_AFTER_MS };
    }

    if (session.state !== "ready") {
      throw new ServiceUnavailableException("The assigned learning lab is not available");
    }

    if (typeof session.data !== "string" || !session.data || typeof session.expires_at !== "number" || !Number.isFinite(session.expires_at)) {
      throw new ServiceUnavailableException("The Labs runtime returned an invalid browser session");
    }

    return {
      state: "ready",
      embedUrl: `${this.guacamolePublicPath()}?data=${encodeURIComponent(session.data)}`,
      expiresAt: session.expires_at,
    };
  }

  private learnerLabMap(): Map<string, string> {
    const configured = process.env.LEARNER_LAB_MAP;
    if (!configured) throw new ServiceUnavailableException("LEARNER_LAB_MAP is not configured");

    let value: unknown;
    try {
      value = JSON.parse(configured);
    } catch {
      throw new ServiceUnavailableException("LEARNER_LAB_MAP must be a JSON object");
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ServiceUnavailableException("LEARNER_LAB_MAP must be a JSON object");
    }

    const entries = Object.entries(value);
    const invalid = entries.some(([learnerId, labId]) => !learnerId || typeof labId !== "string" || !LAB_ID_PATTERN.test(labId));
    if (invalid) throw new ServiceUnavailableException("LEARNER_LAB_MAP contains an invalid learner or lab ID");
    return new Map(entries as Array<[string, string]>);
  }

  private async requestBrowserSession(labId: string, userId: string): Promise<LabsBrowserSession> {
    const token = process.env.LABS_SESSION_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException("LABS_SESSION_TOKEN is not configured");

    const url = this.labsApiUrl(`/v1/vms/${encodeURIComponent(labId)}/browser-sessions`);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ subject: userId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ServiceUnavailableException("The Labs runtime is unavailable");
    }

    if (!response.ok) throw new ServiceUnavailableException("The Labs runtime could not create a browser session");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ServiceUnavailableException("The Labs runtime returned an invalid browser session");
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ServiceUnavailableException("The Labs runtime returned an invalid browser session");
    }
    const session = payload as LabsBrowserSession;
    if (session.lab_id !== labId || typeof session.state !== "string") {
      throw new ServiceUnavailableException("The Labs runtime returned an invalid browser session");
    }
    return session;
  }

  private labsApiUrl(path: string): string {
    const configured = (process.env.LABS_API_BASE_URL ?? DEFAULT_LABS_API_BASE_URL).trim().replace(/\/+$/, "");
    try {
      const url = new URL(configured + path);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
      return url.toString();
    } catch {
      throw new ServiceUnavailableException("LABS_API_BASE_URL is invalid");
    }
  }

  private guacamolePublicPath(): string {
    const configured = (process.env.GUACAMOLE_PUBLIC_PATH ?? DEFAULT_GUACAMOLE_PUBLIC_PATH).trim();
    if (!configured.startsWith("/") || configured.startsWith("//") || configured.includes("?") || configured.includes("#")) {
      throw new ServiceUnavailableException("GUACAMOLE_PUBLIC_PATH must be an absolute URL path");
    }
    return configured.endsWith("/") ? configured : `${configured}/`;
  }
}
