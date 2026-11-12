import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type {
  CanonicalEntry,
  ManifestAgent,
  ManifestSessionResult,
  SyncDaemonConfig,
  SyncRequest,
} from "@pi-agent-hub/protocol";
import { PluginManager, type AgentRuntime } from "./plugin-manager.js";
import { HubClient, type HubEvent } from "./hub-client.js";
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

  constructor(private readonly config: SyncDaemonConfig) {
    this.hub = new HubClient(config);
    this.pluginRoot = expandHome(config.pluginRoot ?? join(homedir(), ".pi-agent-hub", "plugins"));
    // 日志目录与 control logs 读取器一致：写在展开后的 pluginRoot 下，避免把 `~` 当字面目录名
    this.logger = new Logger(join(this.pluginRoot, "logs", "sync-daemon.log"));
    this.manager = new PluginManager({
      pluginRoot: this.pluginRoot,
      pluginInstall: config.pluginInstall ?? true,
      allowlist: config.pluginAllowlist ?? ["@pi-agent-hub/*"],
      agents: config.agents ?? {},
      hostId: config.host.name,
      logger: this.logger,
    });
  }

  async start(once = false): Promise<void> {
    await this.logger.init();
    await this.manager.start(this.config.plugins);
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
    await this.syncAll();
    void this.runEvents();
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
    for (const runtime of this.manager.list()) {
      let listed: { sessions: Array<{ nativeId: string; updatedAt: number; title?: string; cwd?: string; state?: string }> };
      try {
        listed = await runtime.client.request("list_sessions", {}, 60_000);
      } catch (error) {
        await this.logger.warn("agent list_sessions failed, skipping", { kind: runtime.kind, error: String(error) });
        continue;
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
      await this.handleDeliver(data);
    } else if (event.event === "import") {
      await this.handleImport(data);
    } else if (event.event === "export_native") {
      await this.handleExportNative(data);
    } else if (event.event === "reset") {
      await this.logger.warn("SSE reset", data);
    }
  }

  private async handleDeliver(data: Record<string, unknown>): Promise<void> {
    const deliveryId = typeof data.deliveryId === "string" ? data.deliveryId : "";
    const agentId = typeof data.agentId === "string" ? data.agentId : "";
    const nativeSessionId = typeof data.nativeSessionId === "string" ? data.nativeSessionId : "";
    const runtime = this.manager.list().find((candidate) => candidate.agentId === agentId);
    if (!runtime || !deliveryId) return;
    try {
      await this.hub.ack(deliveryId);
      const result = await runtime.client.request<{ ok: boolean; state: string }>("deliver", {
        deliveryId,
        instanceId: runtime.instanceId,
        nativeId: nativeSessionId,
        message: typeof data.message === "string" ? data.message : "",
        images: Array.isArray(data.images) ? data.images : [],
        policy: data.policy,
        force: data.force === true,
      }, 15 * 60_000);
      await this.hub.deliveryResult(deliveryId, { ok: true, result: { state: result.state } });
    } catch (error) {
      await this.hub.deliveryResult(deliveryId, {
        ok: false,
        error: { code: "agent_error", message: String(error), retryable: false },
      });
    }
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
