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
