export const PROTOCOL_VERSION = "1.0" as const;
export const PLUGIN_PROTOCOL_VERSION = "1.0" as const;

export type AgentKind = "pi" | "opencode" | "dsh" | "claude" | "codex" | (string & {});
export type UserRole = "admin" | "viewer";
export type SessionState = "active" | "idle" | "missing" | "error" | "deleted";
export type DeliveryState = "queued" | "dispatched" | "accepted" | "running" | "completed" | "failed" | "expired" | "canceled";
export type ImportState = "queued" | "preparing" | "transferring" | "materializing" | "completed" | "failed";

export interface HubUserConfig {
  username: string;
  /** Dev-only plaintext. Prefer passwordHash. */
  password?: string;
  /** scrypt/argon2 style encoded hash. */
  passwordHash?: string;
  role: UserRole;
  disabled?: boolean;
}

export interface DaemonTokenConfig {
  name: string;
  /** Dev-only plaintext. Prefer tokenHash. */
  token?: string;
  tokenHash?: string;
  hostName: string;
  labels?: string[];
}

export interface HubServerConfig {
  port?: number;
  hostname?: string;
  publicUrl?: string;
}

export interface HubConfig {
  server?: HubServerConfig;
  users: HubUserConfig[];
  daemonTokens: DaemonTokenConfig[];
  dataDir?: string;
  retentionDays?: number;
  maxSessionBytes?: number;
}

export interface PluginSpec {
  package: string;
  options?: Record<string, unknown>;
}

export interface AgentInstanceConfig {
  name: string;
  agentDir?: string;
  dataDir?: string;
  sessionRoot?: string;
}

export interface AgentConfig {
  enabled?: boolean;
  instances?: AgentInstanceConfig[];
  options?: Record<string, unknown>;
  deliver?: {
    enabled?: boolean;
    policy?: "idle-only" | "managed-only" | "force";
    idleSeconds?: number;
  };
  import?: { enabled?: boolean; allowedRoots?: string[] };
}

export interface SyncDaemonConfig {
  hub: {
    url: string;
    token: string;
    tlsPin?: string | null;
    proxy?: string | null;
    heartbeatSeconds?: number;
    sse?: { retryMs?: number };
  };
  host: { name: string; labels?: string[] };
  plugins: (string | PluginSpec)[];
  pluginInstall?: boolean;
  pluginAllowlist?: string[];
  pluginRoot?: string;
  agents?: Record<string, AgentConfig>;
  redaction?: { enabled?: boolean; patternsFile?: string };
  limits?: { maxUploadBytesPerSec?: number; spoolMiB?: number };
  /**
   * 005 工程目录同步：主机 FS Bridge 白名单（loadConfig 已 realpath 归一）。
   * 显式数组：仅数组内目录可访问，[] 表示全禁；null/undefined：回退会话 cwd 集合判定。
   */
  fsAllowedDirs?: string[] | null;
}

export interface NativeSessionMeta {
  nativeId: string;
  nativePath?: string;
  updatedAt: number;
  title?: string;
  cwd?: string;
  state?: "active" | "idle" | "missing";
  entryCount?: number;
}

export interface ManifestAgent {
  agentId: string;
  kind: AgentKind;
  version?: string;
  capabilities?: PluginCapabilities;
  displayName?: string;
  homeDir?: string;
  sessions: Array<{
    nativeId: string;
    updatedAt: number;
    title?: string;
    cwd?: string;
    state?: "active" | "idle" | "missing";
  }>;
}

export interface ManifestRequest {
  requestId?: string;
  agents: ManifestAgent[];
}

export type ManifestStatus = "new" | "ok" | "skipped" | "full" | "quota" | "error";

export interface ManifestSessionResult {
  agentId: string;
  nativeId: string;
  hubSessionId: string;
  lastTimestamp: number | null;
  lastEntryId: string | null;
  status: ManifestStatus;
  entryCount?: number;
}

export interface ManifestResponse {
  serverTime: number;
  sessions: ManifestSessionResult[];
}

export interface CanonicalEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionMeta {
  cwd: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  state?: "active" | "idle" | "missing";
}

export interface SyncRequest {
  requestId?: string;
  agentId: string;
  nativeId: string;
  since?: number;
  mode: "delta" | "full";
  session: SessionMeta;
  entries?: CanonicalEntry[];
  entriesRef?: { uploadId: string };
  truncated?: boolean;
  idempotencyKey?: string;
}

export interface SyncResponse {
  hubSessionId: string;
  merged: number;
  skipped: number;
  lastTimestamp: number;
  lastEntryId: string;
  entryCount: number;
  status: "ok";
}

export interface PluginCapabilities {
  collect: boolean;
  deliver: boolean;
  import: boolean;
  losslessImport: boolean;
  exportNative: boolean;
  controlInterface: "acp" | "native-api" | "cli" | null;
  readStrategy?: Array<"storage" | "api" | "acp">;
  deliveryStrategy?: Array<"acp" | "api">;
  largeReadMode?: "temp-file" | "inline";
  watch?: boolean;
}

export interface PluginMetadata {
  kind: AgentKind;
  protocolVersion: string;
  minDaemonVersion: string;
  capabilities: PluginCapabilities;
  permissions?: {
    fsRead?: string[];
    fsWrite?: string[];
    net?: string[];
    spawn?: string[];
  };
  timeouts?: Record<string, number>;
  maxConcurrency?: number;
  optionsSchema?: string;
}

export interface PluginInitializeParams {
  protocolVersion: string;
  daemonVersion: string;
  hostId: string;
  agentId: string;
  kind: AgentKind;
  workDir: string;
  config: {
    options?: Record<string, unknown>;
    instance?: AgentInstanceConfig;
  };
}

export interface PluginInitializeResult {
  pluginVersion: string;
  protocolVersion: string;
  capabilities: PluginCapabilities;
}

export interface PluginInstance {
  instanceId: string;
  displayName: string;
  homeDir: string;
  version?: string;
}

export interface SessionChunk {
  mode: "delta" | "full";
  since?: number;
  entries?: CanonicalEntry[];
  entriesPath?: string;
  sha256?: string;
  count?: number;
  meta: SessionMeta;
  truncated?: { from: string; reason: string };
}

export interface DeliverRequest {
  deliveryId: string;
  instanceId: string;
  nativeId: string;
  message: string;
  images?: Array<{ mime: string; dataBase64?: string; path?: string }>;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  policy?: string;
  force?: boolean;
}

export interface DeliverResult {
  ok: boolean;
  state: "accepted" | "running" | "completed";
  nativeMessageId?: string;
  warnings?: string[];
}

export interface ImportRequest {
  importId: string;
  instanceId: string;
  bundlePath: string;
  targetCwd: string;
}

export interface ImportResult {
  nativeId: string;
  nativePath: string;
  warnings?: string[];
}

export interface ExportNativeRequest {
  instanceId: string;
  nativeId: string;
  format: string;
  workDir: string;
}

export interface ExportNativeResult {
  nativePath: string;
  format: string;
  sha256: string;
  bytes: number;
}

export type TranscriptBlock =
  | { kind: "text"; text: string; markdown?: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; callId: string; name: string; input: unknown; status: "pending" | "ok" | "error" }
  | { kind: "toolResult"; callId?: string; name: string; ok: boolean; preview: string; bytes: number; truncated: boolean; rawUrl?: string }
  | { kind: "image"; mime: string; url: string; width?: number; height?: number }
  | { kind: "bash"; command: string; output: string; exitCode?: number; cancelled?: boolean }
  | { kind: "summary"; summaryType: "compaction" | "branch"; text: string; tokensBefore?: number }
  | { kind: "diff"; files: Array<{ path: string; patch: string }> }
  | { kind: "meta"; label: string; detail?: string; level?: "info" | "warn" }
  | { kind: "subagentMarker"; agentName: string; parentToolCallId: string; aMessageId: string }
  | { kind: "unknown"; raw: string };

export interface TranscriptItem {
  seq: number;
  entryId: string;
  type: string;
  ts: number;
  role?: "user" | "assistant" | "tool" | "system" | "meta";
  blocks: TranscriptBlock[];
}

// ---- 202-console-session-viewer：会话树 / 虚拟文件树 / 子 agent DTO ----

export interface SessionTreeSessionNode {
  key: string;
  hostId: string;
  agentId: string;
  kind: string | null;
  sessionCount: number;
  sessions: SessionSummaryLike[];
}

export interface SessionTreeProjectNode {
  key: string;
  label: string;
  sessionCount: number;
  agents: SessionTreeSessionNode[];
}

export interface SessionTreeResponse {
  projects: SessionTreeProjectNode[];
  truncated?: boolean;
}

/** 与 hub-service SessionSummary 结构对齐（protocol 不反向依赖 service 包，本地声明同形契约）。 */
export interface SessionSummaryLike {
  id: string;
  hostId: string;
  agentId: string;
  nativeId: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastTimestamp: number | null;
  lastEntryId: string | null;
  entryCount: number;
  bytes: number;
  state: string;
}

export interface VirtualFileNode {
  name: string;
  /** 相对会话 cwd 的 POSIX 风格路径；目录以 / 结尾；越界项挂在 _outside/ 下。 */
  path: string;
  isDir: boolean;
  touchedBy: string[];
  hasContent: boolean;
  confidence: "high" | "low";
  children?: VirtualFileNode[];
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

export interface SubagentListResponse {
  items: SubagentSummary[];
}

export interface SubagentTranscriptResponse {
  subagentId: string;
  items: TranscriptItem[];
  count: number;
}

// ---- 005-sync-workspace：工程目录同步（FS Bridge）DTO ----

/** SSE 事件名：hub -> daemon 下发 FS 请求。 */
export const FS_REQUEST_EVENT = "fs_request" as const;

export type FsRequestKind = "list_dir" | "read_file";
export type FsRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired";

/** 全链路限额与态机时序常量（hub/daemon/测试共用唯一来源）。 */
export const FS_LIMITS = {
  /** 文本文件读取上限 1 MB。 */
  textBytes: 1024 * 1024,
  /** 图片/视频/PDF 读取上限 10 MB。 */
  binaryBytes: 10 * 1024 * 1024,
  /** 单级目录子项上限。 */
  maxDirEntries: 2000,
  /** 请求自建记录起未达终态的 TTL（惰性 expired）。 */
  requestTtlMs: 60_000,
  /** 终态结果内存保留时长。 */
  resultRetentionMs: 5 * 60_000,
} as const;

export type FsErrorCode =
  | "forbidden_role"
  | "csrf_failed"
  | "host_unknown"
  | "host_offline"
  | "path_not_allowed"
  | "invalid_request"
  | "not_found"
  | "denied"
  | "denied_all"
  | "not_a_directory"
  | "not_a_file"
  | "file_too_large"
  | "binary_unsupported"
  | "text_decode_failed"
  | "expired"
  | "daemon_error";

/** console -> hub 发起请求体。 */
export interface CreateFsRequest {
  hostId: string;
  kind: FsRequestKind;
  path: string;
}

export interface FsError {
  code: FsErrorCode;
  message: string;
}

/** list_dir 单级目录项。 */
export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/** list_dir 结果：仅直接子项，truncated 表示触达 maxDirEntries 上限。 */
export interface DirListingResult {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

export interface TextFileContent {
  path: string;
  type: "text";
  content: string;
  size: number;
}

export interface BinaryFileContent {
  path: string;
  type: "image" | "video" | "pdf";
  mimeType: string;
  dataUrl: string;
  size: number;
}

/** read_file 判别联合：文本原文或二进制 base64 data URL。 */
export type FileContentResult = TextFileContent | BinaryFileContent;

export type FsResultData = DirListingResult | FileContentResult;

/** hub 内存态机记录（不持久化，重启即失）。 */
export interface FsRequestRecord {
  requestId: string;
  hostId: string;
  kind: FsRequestKind;
  path: string;
  state: FsRequestState;
  createdAt: number;
  acceptedAt?: number;
  finishedAt?: number;
  result?: FsResultData;
  error?: FsError;
}

/** SSE fs_request 事件 payload。 */
export interface FsRequestEvent {
  requestId: string;
  kind: FsRequestKind;
  path: string;
}

/** 007：下发策略枚举（收敛：idle-only + force，managed-only 后置）。 */
export type DeliveryPolicy = "idle-only" | "force";

/** 007：SSE deliver 事件中的图片引用（hub 落盘后下发，避免 SSE 大包）。 */
export interface DeliverImageUrl {
  mime: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** 007：图片链路限额（console→hub 内联 base64 上传）。 */
export const DELIVERY_IMAGE_LIMITS = {
  /** 单张 base64 解码后字节上限 10 MB。 */
  singleBytes: 10 * 1024 * 1024,
  /** 单次最多张数（对齐 pi-web）。 */
  maxCount: 10,
  /** 单次图片总计字节上限 32 MB（防超大 body 传满）。 */
  totalBytes: 32 * 1024 * 1024,
  /** 允许的 mime 白名单。 */
  mime: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const,
} as const;

/** 007：交付错误码联合。 */
export type DeliveryErrorCode =
  | "forbidden_role" | "csrf_failed" | "invalid_request"
  | "image_invalid" | "image_too_large"
  | "session_not_found" | "session_incomplete" | "host_unknown"
  | "not_found" | "conflict" | "model_not_found" | "unsupported"
  | "agent_error" | "expired" | "image_expired" | "idempotency_conflict" | "host_mismatch";

// ---- 006-sync-model-info：模型信息同步 DTO ----

/** SSE 事件名：hub -> daemon 下发模型信息请求。 */
export const MODEL_INFO_REQUEST_EVENT = "model_info_request" as const;

/** pi 的固定思考深度档位（仅作为参考常量；opencode/dsh 为各自 agent 特定字符串）。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelInfoRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired";

export type ModelInfoErrorCode =
  | "forbidden_role" | "csrf_failed" | "invalid_request"
  | "session_not_found" | "session_incomplete" | "host_unknown" | "host_offline"
  | "not_found" | "expired" | "agent_unsupported" | "agent_error" | "invalid_result" | "host_mismatch";

/** 单条可用模型的最小投影（脱敏：不含 headers/baseUrl/cost/api 等）。 */
export interface ModelInfoEntry {
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  input: string[];
  /** 该模型支持的思考深度（agent 特定字符串，如 pi off..max / dsh reasoningEffort id）。 */
  thinkingLevels: string[];
}

export interface ModelInfoResult {
  agentId: string;
  models: ModelInfoEntry[];
  currentModel?: { provider: string; modelId: string } | null;
  currentThinkingLevel?: string | null;
}

export interface ModelInfoError {
  code: ModelInfoErrorCode;
  message: string;
}

/** hub 内存态机记录（不持久化，重启即失）。 */
export interface ModelInfoRequestRecord {
  requestId: string;
  hostId: string;
  agentId: string;
  sessionId: string;
  state: ModelInfoRequestState;
  createdAt: number;
  acceptedAt?: number;
  finishedAt?: number;
  result?: ModelInfoResult;
  error?: ModelInfoError;
}

/** SSE model_info_request 事件 payload。 */
export interface ModelInfoRequestEvent {
  requestId: string;
  agentId: string;
  nativeSessionId: string;
}

/** daemon -> hub result 回传体。 */
export type ModelInfoResultPayload =
  | { ok: true; result: ModelInfoResult }
  | { ok: false; error: ModelInfoError };

/** 006 全链路限额与态机时序常量（hub/daemon/测试共用）。 */
export const MODEL_INFO_LIMITS = {
  /** 请求自建记录起未达终态的 TTL（惰性 expired）。 */
  requestTtlMs: 60_000,
  /** 终态结果内存保留时长。 */
  resultRetentionMs: 5 * 60_000,
  /** 打开态记录软上限（超出淘汰最老非终态）。 */
  maxOpenRecords: 10_000,
} as const;

/** daemon -> hub result 回传体（判别联合）。 */
export type FsResultPayload =
  | { ok: true; result: FsResultData }
  | { ok: false; error: FsError };
