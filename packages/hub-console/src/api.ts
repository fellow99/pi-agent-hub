export interface SessionSummary {
  id: string;
  hostId: string;
  agentId: string;
  nativeId: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastTimestamp: number | null;
  entryCount: number;
  state: string;
}

export interface TranscriptItem {
  seq: number;
  entryId: string;
  type: string;
  ts: number;
  role?: string;
  blocks: Array<Record<string, unknown>>;
}

const csrfKey = "pi-agent-hub.csrf";

export function setCsrf(token: string): void {
  localStorage.setItem(csrfKey, token);
}

export function getCsrf(): string {
  return localStorage.getItem(csrfKey) ?? "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-CSRF-Token", getCsrf());
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? JSON.stringify((body as { error: unknown }).error)
      : text;
    throw new Error(`${response.status}: ${message}`);
  }
  return body as T;
}

export async function login(username: string, password: string): Promise<void> {
  const result = await api<{ csrfToken: string }>("/api/hub/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setCsrf(result.csrfToken);
}

export async function logout(): Promise<void> {
  await api("/api/hub/auth/logout", { method: "POST", body: "{}" });
  localStorage.removeItem(csrfKey);
}

export async function listSessions(): Promise<SessionSummary[]> {
  const result = await api<{ items: SessionSummary[] }>("/api/hub/sessions");
  return result.items;
}

export interface AgentRow {
  id: string;
  hostId: string;
  kind: string;
  version: string | null;
  displayName: string | null;
  homeDir: string | null;
  capabilities: Record<string, unknown>;
  status: string;
  lastSeenAt: number | null;
}

export async function listAgents(): Promise<AgentRow[]> {
  const result = await api<{ items: AgentRow[] }>("/api/hub/agents");
  return result.items;
}

export async function getSession(id: string): Promise<SessionSummary> {
  return api<SessionSummary>(`/api/hub/sessions/${encodeURIComponent(id)}`);
}

export async function getTranscript(id: string, before?: number): Promise<{ items: TranscriptItem[]; hasMore: boolean }> {
  const query = new URLSearchParams({ tail: "100" });
  if (before) query.set("before", String(before));
  return api(`/api/hub/sessions/${encodeURIComponent(id)}/transcript?${query.toString()}`);
}
