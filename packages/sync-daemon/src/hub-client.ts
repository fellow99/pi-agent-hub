import type {
  DeliverRequest,
  ManifestRequest,
  ManifestResponse,
  SyncDaemonConfig,
  SyncRequest,
  SyncResponse,
} from "@pi-agent-hub/protocol";

export interface HubEvent {
  id?: string;
  event: string;
  data: unknown;
}

export class HubClient {
  private readonly base: string;
  private readonly token: string;
  private lastEventId: string | undefined;

  constructor(private readonly config: SyncDaemonConfig) {
    this.base = config.hub.url.replace(/\/+$/, "");
    this.token = config.hub.token;
  }

  async manifest(body: ManifestRequest): Promise<ManifestResponse> {
    return this.request("/api/v1/sync/manifest", { method: "POST", body });
  }

  async sync(hubSessionId: string, body: SyncRequest): Promise<SyncResponse> {
    return this.request(`/api/v1/sync/sessions/${encodeURIComponent(hubSessionId)}`, { method: "POST", body });
  }

  async createUpload(body: {
    kind: string;
    hubSessionId: string;
    mode: "full" | "delta";
    since?: number;
    encoding: "ndjson+gzip";
    totalEntries?: number;
  }): Promise<{ uploadId: string; putUrl: string; expiresAt: number; maxBytes: number }> {
    return this.request("/api/v1/uploads", { method: "POST", body });
  }

  async putUpload(uploadId: string, gzipBytes: Buffer, digestBase64: string): Promise<void> {
    const response = await fetch(`${this.base}/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        Digest: `sha-256=${digestBase64}`,
        "X-Daemon-Version": "0.1.0",
      },
      body: gzipBytes,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`hub ${response.status} PUT /api/v1/uploads/${uploadId}: ${text.slice(0, 300)}`);
  }

  async ack(deliveryId: string): Promise<void> {
    await this.request(`/api/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`, { method: "POST", body: {} });
  }

  async deliveryResult(deliveryId: string, body: unknown): Promise<void> {
    await this.request(`/api/v1/deliveries/${encodeURIComponent(deliveryId)}/result`, { method: "POST", body });
  }

  async importResult(importId: string, body: unknown): Promise<void> {
    await this.request(`/api/v1/imports/${encodeURIComponent(importId)}/result`, { method: "POST", body });
  }

  async exportResult(exportId: string, body: unknown): Promise<void> {
    await this.request(`/api/v1/exports/${encodeURIComponent(exportId)}/result`, { method: "POST", body });
  }

  async request<T>(path: string, init: { method: string; body: unknown }): Promise<T> {
    const response = await fetch(this.base + path, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-Daemon-Version": "0.1.0",
      },
      body: JSON.stringify(init.body),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`hub ${response.status} ${path}: ${text.slice(0, 300)}`);
    }
    return parsed as T;
  }

  async connectEvents(
    onEvent: (event: HubEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "text/event-stream",
      "X-Daemon-Version": "0.1.0",
    };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;
    const response = await fetch(`${this.base}/api/v1/events`, { headers, signal });
    if (!response.ok || !response.body) throw new Error(`SSE connect failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = parseFrame(frame);
        if (event) {
          if (event.id) this.lastEventId = event.id;
          await onEvent(event);
        }
        split = buffer.indexOf("\n\n");
      }
    }
  }
}

function parseFrame(frame: string): HubEvent | undefined {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return undefined;
  try {
    return { id, event, data: JSON.parse(data.join("\n")) as unknown };
  } catch {
    return undefined;
  }
}
