import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type {
  CanonicalEntry,
  FsErrorCode,
  ManifestAgent,
  ManifestSessionResult,
  SyncDaemonConfig,
  SyncRequest,
} from "@pi-agent-hub/protocol";
import { FS_REQUEST_EVENT, MODEL_INFO_REQUEST_EVENT } from "@pi-agent-hub/protocol";
import { PluginManager, type AgentRuntime } from "./plugin-manager.js";
import { HubClient, type HubEvent } from "./hub-client.js";
import { FsBridge, FsError } from "./fs-bridge.js";
import { DeliverExecutor } from "./deliver-executor.js";
import { Logger } from "./logger.js";
import { startControlServer } from "./control.js";
import { expandHome } from "@pi-agent-hub/sync-plugin-sdk";
import { defaultConfigPath, loadConfig } from "./config.js";

/** 内联同步的负载上限（解压后估算）。超过则走 upload 流（§4.5），避免大包被反代/隧道限额拒收。 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export class Daemon {
  private readonly hub: HubClient;
  private readonly logger: Logger;
  private readonly manager: PluginManager;
  private readonly pluginRoot: string;
  private controlState: import("./control.js").ControlState | undefined;
  private stopping = false;
  private readonly abort = new AbortController();
  private control: import("node:http").Server | undefined;
  /** null 回退模式的会话 cwd 快照（realpath 归一），每次 syncAll 刷新。 */
  private knownCwds = new Set<string>();
  private readonly fsBridge: FsBridge;
  private readonly executor: DeliverExecutor;

  constructor(private readonly config: SyncDaemonConfig) {
    this.hub = new HubClient(config);
    this.pluginRoot = expandHome(config.pluginRoot ?? join(homedir(), ".pi-agent-hub", "plugins"));
    // 日志目录与 control logs 读取器一致：写在展开后的 pluginRoot 下，避免把 `~` 当字面目录名
    this.logger = new Logger(join(this.pluginRoot, "logs", "sync-daemon.log"));
    const explicit = Array.isArray(config.fsAllowedDirs);
    this.fsBridge = new FsBridge({
      isExplicitMode: () => explicit,
      getRoots: () => config.fsAllowedDirs ?? [],
      getKnownCwds: () => [...this.knownCwds],
    });
    this.manager = new PluginManager({
      pluginRoot: this.pluginRoot,
      pluginInstall: config.pluginInstall ?? true,
      allowlist: config.pluginAllowlist ?? ["@pi-agent-hub/*"],
      agents: config.agents ?? {},
      hostId: config.host.name,
      logger: this.logger,
    });
    // 007/006 执行器：挂在 manager 创建之后（依赖 manager/hub/logger）。
    this.executor = new DeliverExecutor({
      hub: this.hub,
      manager: this.manager,
      logger: this.logger,
      workDir: expandHome(config.pluginRoot ?? join(homedir(), ".pi-agent-hub", "plugins")),
      stateDir: expandHome(config.pluginRoot ?? join(homedir(), ".pi-agent-hub", "plugins")),
    });
  }

  async start(once = false): Promise<void> {
    await this.logger.init();
    await this.manager.start(this.config.plugins);
    await this.executor.init();
    const controlState: import("./control.js").ControlState = {
      paused: false,
      status: () => ({
        host: this.config.host.name,
        plugins: this.manager.list().map((runtime) => ({
          kind: runtime.kind,
          agentId: runtime.agentId,
          instanceId: runtime.instanceId,
          homeDir: runtime.homeDir,
        })),
      }),
      syncNow: () => this.syncAll(),
      logs: async (tail) => {
        try {
          const text = await readFile(join(this.pluginRoot, "logs", "sync-daemon.log"), "utf8");
          return text.split("\n").slice(-Math.max(1, tail)).join("\n");
        } catch {
          return "";
        }
      },
      quit: () => void this.stop(),
    };
    this.controlState = controlState;
    this.control = await startControlServer(controlState, this.pluginRoot, this.logger);
    if (once) {
      await this.syncAll();
      await this.stop();
      return;
    }
    // SSE 事件连接必须先于首次全量同步启动且不 await：远程主机会话量大时首次 syncAll
    // 可能持续很久（海量 upload），若先 await 会把 runEvents 饿死，导致 hub 侧始终看不到
    // 活跃事件连接（FS Bridge 等下发能力报 host_offline）。runEvents 内部自带断线重连。
    void this.runEvents();
    void this.syncAll().catch((error) => this.logger.error("initial sync failed", { error: String(error) }));
    setInterval(() => {
      if (!this.controlState?.paused) void this.syncAll().catch((error) => this.logger.error("scheduled sync failed", { error: String(error) }));
    }, 30_000);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    this.control?.close();
    await this.manager.stop();
  }

  private async syncAll(): Promise<void> {
    if (this.controlState?.paused) return;
    const agents: ManifestAgent[] = [];
    const discoveredCwds: string[] = [];
    for (const runtime of this.manager.list()) {
      let listed: { sessions: Array<{ nativeId: string; updatedAt: number; title?: string; cwd?: string; state?: string }> };
      try {
        listed = await runtime.client.request("list_sessions", {}, 60_000);
      } catch (error) {
        await this.logger.warn("agent list_sessions failed, skipping", { kind: runtime.kind, error: String(error) });
        continue;
      }
      for (const session of listed.sessions) {
        if (session.cwd) discoveredCwds.push(session.cwd);
      }
      agents.push({
        agentId: runtime.agentId,
        kind: runtime.kind,
        version: runtime.plugin.version,
        capabilities: runtime.capabilities,
        displayName: runtime.displayName,
        homeDir: runtime.homeDir,
        sessions: listed.sessions.map((session) => ({
          nativeId: session.nativeId,
          updatedAt: session.updatedAt,
          title: session.title,
          cwd: session.cwd,
          state: session.state as "active" | "idle" | "missing" | undefined,
        })),
      });
    }
    await this.refreshKnownCwds(discoveredCwds);
    if (agents.length === 0) return;
    const manifest = await this.hub.manifest({ agents });
    for (const item of manifest.sessions) {
      if (item.status === "skipped" || item.status === "quota" || item.status === "error") continue;
      const runtime = this.manager.list().find((candidate) => candidate.agentId === item.agentId);
      if (!runtime) continue;
      await this.syncOne(runtime, item);
    }
  }

  private async syncOne(runtime: AgentRuntime, item: ManifestSessionResult): Promise<void> {
    try {
      const chunk = await runtime.client.request<{
        mode: "delta" | "full";
        since?: number;
        entries?: CanonicalEntry[];
        entriesPath?: string;
        meta: SyncRequest["session"];
      }>("read_session", {
        agentId: runtime.agentId,
        nativeId: item.nativeId,
        since: item.lastTimestamp ?? undefined,
        lastEntryId: item.lastEntryId ?? undefined,
        workDir: join(this.pluginRoot, ".work", runtime.kind),
      }, 120_000);

      const entries = chunk.entries ?? await this.readEntriesFile(chunk.entriesPath);
      if (entries.length === 0 && item.lastTimestamp !== null) return;
      const base = {
        agentId: runtime.agentId,
        nativeId: item.nativeId,
        since: item.lastTimestamp ?? undefined,
        mode: chunk.mode,
        session: chunk.meta,
      };
      const estBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
      if (estBytes > MAX_INLINE_BYTES) {
        await this.syncLarge(item.hubSessionId, entries, base);
      } else {
        await this.hub.sync(item.hubSessionId, { ...base, entries });
      }
    } catch (error) {
      await this.logger.error("session sync failed", { hubSessionId: item.hubSessionId, error: String(error) });
    }
  }

  /** 大负载走 upload 流（§4.5）：创建 upload → PUT 压缩 NDJSON → 以 entriesRef 提交同步 */
  private async syncLarge(
    hubSessionId: string,
    entries: CanonicalEntry[],
    base: { agentId: string; nativeId: string; since?: number; mode: "delta" | "full"; session: SyncRequest["session"] },
  ): Promise<void> {
    const upload = await this.hub.createUpload({
      kind: "session-entries",
      hubSessionId,
      mode: base.mode,
      since: base.since,
      encoding: "ndjson+gzip",
      totalEntries: entries.length,
    });
    const ndjson = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const gz = gzipSync(Buffer.from(ndjson, "utf8"));
    const digestBase64 = createHash("sha256").update(gz).digest("base64");
    await this.hub.putUpload(upload.uploadId, gz, digestBase64);
    await this.hub.sync(hubSessionId, { ...base, entriesRef: { uploadId: upload.uploadId } });
    await this.logger.info("session synced via upload", { hubSessionId, uploadId: upload.uploadId, totalEntries: entries.length, gzipBytes: gz.length });
  }

  private async readEntriesFile(path: string | undefined): Promise<CanonicalEntry[]> {
    if (!path) return [];
    const text = await readFile(path, "utf8");
    const entries: CanonicalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as CanonicalEntry);
    }
    return entries;
  }

  private async runEvents(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.hub.connectEvents((event) => this.handleEvent(event), this.abort.signal);
      } catch (error) {
        if (this.stopping) return;
        await this.logger.warn("SSE disconnected", { error: String(error) });
      }
      await delay(3_000);
    }
  }

  private async handleEvent(event: HubEvent): Promise<void> {
    const data = event.data;
    if (!isRecord(data)) return;
    if (event.event === "deliver") {
      await this.executor.execute(data, (runtime, nativeId) => this.syncSessionNow(runtime, nativeId));
    } else if (event.event === "import") {
      await this.handleImport(data);
    } else if (event.event === "export_native") {
      await this.handleExportNative(data);
    } else if (event.event === FS_REQUEST_EVENT) {
      await this.handleFsRequest(data);
    } else if (event.event === MODEL_INFO_REQUEST_EVENT) {
      await this.executor.handleModelInfo(data);
    } else if (event.event === "reset") {
      await this.logger.warn("SSE reset", data);
    }
  }

  /** 005：刷新 null 回退模式的 cwd 快照；realpath 失败的条目跳过并告警。 */
  private async refreshKnownCwds(cwds: string[]): Promise<void> {
    const next = new Set<string>();
    await Promise.all(cwds.map(async (cwd) => {
      try {
        next.add(await realpath(cwd));
      } catch {
        await this.logger.warn("known cwd realpath failed, skipping", { cwd });
      }
    }));
    this.knownCwds = next;
  }

  /** 005：FS Bridge 事件：ack -> 白名单终判 -> 只读执行 -> result 回传；异常也回 ok:false。 */
  private async handleFsRequest(data: Record<string, unknown>): Promise<void> {
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    const kind = data.kind === "list_dir" || data.kind === "read_file" ? data.kind : null;
    const path = typeof data.path === "string" ? data.path : "";
    if (!requestId || !kind || !path) {
      await this.logger.warn("malformed fs_request event ignored", data);
      return;
    }
    try {
      await this.hub.fsAck(requestId);
    } catch (error) {
      await this.logger.warn("fs ack failed, continue execution", { requestId, error: String(error) });
    }
    try {
      const result = kind === "list_dir"
        ? await this.fsBridge.listDir(path)
        : await this.fsBridge.readFile(path);
      await this.hub.fsResult(requestId, { ok: true, result });
    } catch (error) {
      const fsError = toFsError(error);
      await this.logger.warn("fs request failed", { requestId, kind, code: fsError.code });
      try {
        await this.hub.fsResult(requestId, { ok: false, error: fsError });
      } catch (reportError) {
        await this.logger.error("fs result report failed", { requestId, error: String(reportError) });
      }
    }
  }

  /** 007：下发完成后触发该会话一次同步（单 agent manifest → 差分），使新消息尽快出现在 hub 镜像。 */
  private async syncSessionNow(runtime: AgentRuntime, nativeId: string): Promise<void> {
    let listed: { sessions: Array<{ nativeId: string; updatedAt: number; title?: string; cwd?: string; state?: string }> };
    try {
      listed = await runtime.client.request("list_sessions", {}, 60_000);
    } catch (error) {
      await this.logger.warn("post-deliver list_sessions failed", { kind: runtime.kind, error: String(error) });
      return;
    }
    const session = listed.sessions.find((candidate) => candidate.nativeId === nativeId);
    if (!session) return;
    const manifest = await this.hub.manifest({
      agents: [{
        agentId: runtime.agentId,
        kind: runtime.kind,
        version: runtime.plugin.version,
        capabilities: runtime.capabilities,
        displayName: runtime.displayName,
        homeDir: runtime.homeDir,
        sessions: [{
          nativeId: session.nativeId,
          updatedAt: session.updatedAt,
          title: session.title,
          cwd: session.cwd,
          state: session.state as "active" | "idle" | "missing" | undefined,
        }],
      }],
    });
    for (const item of manifest.sessions) {
      if (item.status === "skipped" || item.status === "quota" || item.status === "error") continue;
      await this.syncOne(runtime, item);
    }
  }

  private async handleDeliver(data: Record<string, unknown>): Promise<void> {
    await this.executor.execute(data, (runtime, nativeId) => this.syncSessionNow(runtime, nativeId));
  }

  private async handleImport(data: Record<string, unknown>): Promise<void> {
    const importId = typeof data.importId === "string" ? data.importId : "";
    const targetAgentId = typeof data.targetAgentId === "string" ? data.targetAgentId : "";
    const runtime = this.manager.list().find((candidate) => candidate.agentId === targetAgentId);
    if (!runtime || !importId) return;
    try {
      const result = await runtime.client.request<{ nativeId: string; nativePath: string; warnings?: string[] }>("import_session", {
        importId,
        instanceId: runtime.instanceId,
        bundlePath: typeof data.bundlePath === "string" ? data.bundlePath : "",
        targetCwd: typeof data.targetCwd === "string" ? data.targetCwd : "",
      }, 30 * 60_000);
      await this.hub.importResult(importId, { ok: true, result });
    } catch (error) {
      await this.hub.importResult(importId, {
        ok: false,
        error: { code: "unsupported", message: String(error), retryable: false },
      });
    }
  }

  private async handleExportNative(data: Record<string, unknown>): Promise<void> {
    const exportId = typeof data.exportId === "string" ? data.exportId : "";
    const agentId = typeof data.agentId === "string" ? data.agentId : "";
    const runtime = this.manager.list().find((candidate) => candidate.agentId === agentId);
    if (!runtime || !exportId) return;
    try {
      const result = await runtime.client.request<{ nativePath: string; format: string; sha256: string; bytes: number }>("export_native", {
        instanceId: runtime.instanceId,
        nativeId: typeof data.nativeSessionId === "string" ? data.nativeSessionId : "",
        format: typeof data.format === "string" ? data.format : "pi-jsonl-v3",
        workDir: join(this.pluginRoot, ".work", runtime.kind),
      }, 120_000);
      await this.hub.exportResult(exportId, { ok: true, result });
    } catch (error) {
      await this.hub.exportResult(exportId, {
        ok: false,
        error: { code: "unsupported", message: String(error), retryable: false },
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 005：把 FsBridge 异常归一为协议错误体；未知异常归 daemon_error。 */
function toFsError(error: unknown): { code: FsErrorCode; message: string } {
  if (error instanceof FsError) return { code: error.code, message: error.message };
  return { code: "daemon_error", message: error instanceof Error ? error.message : String(error) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDaemon(options: { configPath?: string; once?: boolean } = {}): Promise<void> {
  const config = await loadConfig(options.configPath ?? defaultConfigPath());
  const daemon = new Daemon(config);
  process.once("SIGINT", () => void daemon.stop());
  process.once("SIGTERM", () => void daemon.stop());
  await daemon.start(options.once ?? false);
}
