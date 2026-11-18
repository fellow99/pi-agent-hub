import { currentApiBase, currentAppBase } from "./base-path.js";

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

export type TranscriptBlock =
  | { kind: "text"; text: string; markdown?: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; callId: string; name: string; input: unknown; status: string }
  | { kind: "toolResult"; callId?: string; name: string; ok: boolean; preview: string; bytes: number; truncated: boolean }
  | { kind: "image"; mime: string; url: string }
  | { kind: "attachment"; mime: string; url: string; name?: string }
  | { kind: "bash"; command: string; output: string; exitCode?: number }
  | { kind: "summary"; summaryType: string; text: string }
  | { kind: "meta"; label: string; detail?: string }
  | { kind: "subagentMarker"; agentName: string; parentToolCallId: string; aMessageId: string }
  | { kind: "diff"; files: Array<{ path: string; patch: string }> }
  | { kind: "unknown"; raw: string };

export interface TranscriptItem {
  seq: number;
  entryId: string;
  type: string;
  ts: number;
  role?: string;
  blocks: TranscriptBlock[];
}

export interface SessionTreeAgentNode {
  key: string;
  hostId: string;
  agentId: string;
  kind: string | null;
  sessionCount: number;
  sessions: SessionSummary[];
}

export interface SessionTreeProjectNode {
  key: string;
  label: string;
  sessionCount: number;
  agents: SessionTreeAgentNode[];
}

export interface SessionTreeResponse {
  projects: SessionTreeProjectNode[];
}

export interface VirtualFileNode {
  name: string;
  path: string;
  isDir: boolean;
  touchedBy: string[];
  hasContent: boolean;
  confidence: "high" | "low";
  children: VirtualFileNode[];
}

export interface SessionFilesResponse {
  cwd: string;
  root: VirtualFileNode;
  truncated: boolean;
  pathCount: number;
}

export interface FileContentResponse {
  path: string;
  available: boolean;
  reason?: "no_mirror_content";
  source?: "write_input" | "read_result";
  toolName?: string;
  entrySeq?: number;
  content?: string;
  truncated?: boolean;
}

export interface SubagentSummary {
  subagentId: string;
  agentName: string;
  markerCount: number;
  firstTs: number | null;
  lastTs: number | null;
  description: string | null;
}

const csrfKey = "pi-agent-hub.csrf";
const roleKey = "pi-agent-hub.role";

export function setCsrf(token: string): void {
  localStorage.setItem(csrfKey, token);
}

export function getCsrf(): string {
  return localStorage.getItem(csrfKey) ?? "";
}

/** 005：登录角色仅用于 UI 权限空状态；服务端 POST 仍强制 admin+CSRF（纵深防御）。 */
export function getRole(): "admin" | "viewer" | null {
  const role = localStorage.getItem(roleKey);
  return role === "admin" || role === "viewer" ? role : null;
}

function setRole(role: string): void {
  if (role === "admin" || role === "viewer") localStorage.setItem(roleKey, role);
}

function clearRole(): void {
  localStorage.removeItem(roleKey);
}

/** 会话失效（重启/登出/过期）时清本地状态并回登录页，避免界面停留在裸 401 alert。 */
function handleUnauthorized(): void {
  localStorage.removeItem(csrfKey);
  clearRole();
  // 避免在登录页自身重复跳转
  if (!window.location.pathname.endsWith("/login")) {
    window.location.assign(`${currentAppBase()}login`);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-CSRF-Token", getCsrf());
  // 入参 path 约定以 "/api/" 开头；按当前部署前缀推导真实地址：
  // 直连 -> /api/...，子路径反代 -> /hub-service/api/...
  const url = currentApiBase() + path.replace(/^\/api\//, "");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    const message = typeof body === "object" && body !== null && "error" in body
      ? JSON.stringify((body as { error: unknown }).error)
      : text;
    throw new Error(`${response.status}: ${message}`);
  }
  return body as T;
}

export async function login(username: string, password: string): Promise<void> {
  const result = await api<{ csrfToken: string; role: string }>("/api/hub/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setCsrf(result.csrfToken);
  setRole(result.role);
}

export async function logout(): Promise<void> {
  await api("/api/hub/auth/logout", { method: "POST", body: "{}" });
  localStorage.removeItem(csrfKey);
  clearRole();
}

export async function getSessionTree(q?: string): Promise<SessionTreeResponse> {
  const query = q ? `?q=${encodeURIComponent(q)}` : "";
  return api<SessionTreeResponse>(`/api/hub/session-tree${query}`);
}

export async function getTranscript(
  id: string,
  before?: number,
  tail = 100,
): Promise<{ items: TranscriptItem[]; hasMore: boolean; oldestSeq: number; newestSeq: number }> {
  const params = new URLSearchParams({ tail: String(tail) });
  if (before !== undefined) params.set("before", String(before));
  return api(`/api/hub/sessions/${encodeURIComponent(id)}/transcript?${params.toString()}`);
}

export async function getSessionFiles(id: string): Promise<SessionFilesResponse> {
  return api(`/api/hub/sessions/${encodeURIComponent(id)}/files`);
}

export async function getFileContent(id: string, path: string): Promise<FileContentResponse> {
  return api(`/api/hub/sessions/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`);
}

export async function listSubagents(id: string): Promise<SubagentSummary[]> {
  const result = await api<{ items: SubagentSummary[] }>(`/api/hub/sessions/${encodeURIComponent(id)}/subagents`);
  return result.items;
}

export async function getSubagentTranscript(
  id: string,
  subagentId: string,
): Promise<{ items: TranscriptItem[]; count: number }> {
  return api(
    `/api/hub/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(subagentId)}/transcript`,
  );
}

// ---- 005-sync-workspace：工程目录同步 FS Bridge 客户端（类型与 protocol 同形，本地镜像） ----

export type FsRequestKind = "list_dir" | "read_file";
export type FsRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired";

export interface FsError {
  code: string;
  message: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirListingResult {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

export type FileContentResult =
  | { path: string; type: "text"; content: string; size: number }
  | { path: string; type: "image" | "video" | "pdf"; mimeType: string; dataUrl: string; size: number };

export interface FsRequestRecord {
  requestId: string;
  state: FsRequestState;
  kind: FsRequestKind;
  path: string;
  result?: DirListingResult | FileContentResult;
  error?: FsError;
}

/** 携带错误码的异常，供界面映射中文提示。 */
export class FsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FsRequestError";
  }
}

const FS_POLL_INTERVAL_MS = 1000;
const FS_TIMEOUT_MS: Record<FsRequestKind, number> = {
  list_dir: 30_000,
  read_file: 60_000,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

export async function createFsRequest(
  hostId: string,
  kind: FsRequestKind,
  path: string,
): Promise<{ requestId: string }> {
  return api("/api/hub/fs-requests", {
    method: "POST",
    body: JSON.stringify({ hostId, kind, path }),
  });
}

export async function pollFsRequest(requestId: string, signal?: AbortSignal): Promise<FsRequestRecord> {
  return api(`/api/hub/fs-requests/${encodeURIComponent(requestId)}`, { signal });
}

/** create -> 1s 轮询直到终态/超时；AbortSignal 取消时静默退出。 */
async function waitFsResult<T extends DirListingResult | FileContentResult>(
  kind: FsRequestKind,
  hostId: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const { requestId } = await createFsRequest(hostId, kind, path);
  const deadline = Date.now() + FS_TIMEOUT_MS[kind];
  for (;;) {
    await sleep(FS_POLL_INTERVAL_MS, signal);
    const record = await pollFsRequest(requestId, signal);
    if (record.state === "completed" && record.result) {
      return record.result as T;
    }
    if (record.state === "failed" && record.error) {
      throw new FsRequestError(record.error.code, record.error.message);
    }
    if (record.state === "expired") {
      throw new FsRequestError("expired", "主机响应超时，可重试");
    }
    if (Date.now() > deadline) {
      throw new FsRequestError("timeout", "主机响应超时");
    }
  }
}

export async function listDir(
  hostId: string,
  path: string,
  signal?: AbortSignal,
): Promise<DirListingResult> {
  return waitFsResult<DirListingResult>("list_dir", hostId, path, signal);
}

export async function readFile(
  hostId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileContentResult> {
  return waitFsResult<FileContentResult>("read_file", hostId, path, signal);
}

// ---- 006-sync-model-info：模型信息同步客户端（类型与 protocol 同形，本地镜像） ----

export type ModelInfoRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired";

export interface ModelInfoEntry {
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  input: string[];
  thinkingLevels: string[];
}

export interface ModelInfoResult {
  agentId: string;
  models: ModelInfoEntry[];
  currentModel?: { provider: string; modelId: string } | null;
  currentThinkingLevel?: string | null;
}

export interface ModelInfoRequestRecord {
  requestId: string;
  state: ModelInfoRequestState;
  result?: ModelInfoResult;
  error?: { code: string; message: string };
}

export class ModelInfoError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ModelInfoError";
  }
}

const MODEL_INFO_POLL_INTERVAL_MS = 1000;
const MODEL_INFO_TIMEOUT_MS = 30_000;
/** sessionId → { fetchedAt, result }，30s TTL 缓存。 */
const modelInfoCache = new Map<string, { fetchedAt: number; result: ModelInfoResult }>();
const MODEL_INFO_CACHE_TTL_MS = 30_000;

export async function createModelInfoRequest(sessionId: string): Promise<{ requestId: string }> {
  return api("/api/hub/model-info-requests", { method: "POST", body: JSON.stringify({ sessionId }) });
}

export async function pollModelInfoRequest(requestId: string, signal?: AbortSignal): Promise<ModelInfoRequestRecord> {
  return api(`/api/hub/model-info-requests/${encodeURIComponent(requestId)}`, { signal });
}

/** create -> 1s 轮询至终态/超时；带 session 级 30s 缓存。 */
export async function getModelInfo(sessionId: string, signal?: AbortSignal, force = false): Promise<ModelInfoResult> {
  if (!force) {
    const cached = modelInfoCache.get(sessionId);
    if (cached && Date.now() - cached.fetchedAt < MODEL_INFO_CACHE_TTL_MS) return cached.result;
  }
  const { requestId } = await createModelInfoRequest(sessionId);
  const deadline = Date.now() + MODEL_INFO_TIMEOUT_MS;
  for (;;) {
    await sleep(MODEL_INFO_POLL_INTERVAL_MS, signal);
    const record = await pollModelInfoRequest(requestId, signal);
    if (record.state === "completed" && record.result) {
      modelInfoCache.set(sessionId, { fetchedAt: Date.now(), result: record.result });
      return record.result;
    }
    if (record.state === "failed" && record.error) {
      throw new ModelInfoError(record.error.code, record.error.message);
    }
    if (record.state === "expired") throw new ModelInfoError("expired", "主机响应超时，可重试");
    if (Date.now() > deadline) throw new ModelInfoError("timeout", "主机响应超时");
  }
}

export function clearModelInfoCache(sessionId?: string): void {
  if (sessionId) modelInfoCache.delete(sessionId);
  else modelInfoCache.clear();
}

// ---- 007-push-prompt：下发客户端（类型与 protocol 同形，本地镜像） ----

export type DeliveryState =
  | "queued" | "dispatched" | "accepted" | "running" | "completed" | "failed" | "expired" | "canceled";

export interface DeliveryRecord {
  deliveryId: string;
  state: DeliveryState;
  sessionId: string;
  error?: { code: string; message: string };
  warnings?: string[];
}

export interface SendDeliveryPayload {
  sessionId: string;
  text: string;
  images?: { mime: string; dataBase64: string; name?: string }[];
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  policy?: "idle-only" | "force";
  force?: boolean;
  idempotencyKey?: string;
}

export async function sendDelivery(payload: SendDeliveryPayload): Promise<{ deliveryId: string; state: DeliveryState }> {
  return api("/api/hub/deliveries", { method: "POST", body: JSON.stringify(payload) });
}

export async function pollDelivery(deliveryId: string, signal?: AbortSignal): Promise<DeliveryRecord> {
  return api(`/api/hub/deliveries/${encodeURIComponent(deliveryId)}`, { signal });
}

export async function cancelDelivery(deliveryId: string): Promise<void> {
  await api(`/api/hub/deliveries/${encodeURIComponent(deliveryId)}/cancel`, { method: "POST", body: "{}" });
}
