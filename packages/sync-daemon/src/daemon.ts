import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
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
import { defaultConfigPath, loadConfig } from "./config.js";

export class Daemon {
  private readonly hub: HubClient;
  private readonly logger: Logger;
  private readonly manager: PluginManager;
  private controlState: import("./control.js").ControlState | undefined;
  private stopping = false;
  private readonly abort = new AbortController();
  private control: import("node:http").Server | undefined;

  constructor(private readonly config: SyncDaemonConfig) {
    this.hub = new HubClient(config);
    const dataDir = config.pluginRoot ?? join(homedir(), ".pi-agent-hub");
    this.logger = new Logger(join(dataDir, "logs", "sync-daemon.log"));
    this.manager = new PluginManager({
      pluginRoot: config.pluginRoot ?? join(homedir(), ".pi-agent-hub", "plugins"),
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
          const text = await readFile(join(this.config.pluginRoot ?? "", "logs", "sync-daemon.log"), "utf8");
          return text.split("\n").slice(-Math.max(1, tail)).join("\n");
        } catch {
          return "";
        }
      },
      quit: () => void this.stop(),
    };
    this.controlState = controlState;
    this.control = await startControlServer(controlState, this.config.pluginRoot ?? join(process.cwd(), ".pi-agent-hub"), this.logger);
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
      const listed = await runtime.client.request<{ sessions: Array<{ nativeId: string; updatedAt: number; title?: string; cwd?: string; state?: string }> }>(
        "list_sessions",
        {},
        60_000,
      );
      agents.push({
        agentId: runtime.agentId,
        kind: runtime.kind,
        capabilities: runtime.capabilities,
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
        workDir: join(this.config.pluginRoot ?? "", ".work", runtime.kind),
      }, 120_000);

      const entries = chunk.entries ?? await this.readEntriesFile(chunk.entriesPath);
      if (entries.length === 0 && item.lastTimestamp !== null) return;
      await this.hub.sync(item.hubSessionId, {
        agentId: runtime.agentId,
        nativeId: item.nativeId,
        since: item.lastTimestamp ?? undefined,
        mode: chunk.mode,
        session: chunk.meta,
        entries,
      });
    } catch (error) {
      await this.logger.error("session sync failed", { hubSessionId: item.hubSessionId, error: String(error) });
    }
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
        workDir: join(this.config.pluginRoot ?? "", ".work", runtime.kind),
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
