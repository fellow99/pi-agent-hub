import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CanonicalEntry,
  DeliverRequest,
  DeliverResult,
  ExportNativeRequest,
  ExportNativeResult,
  ImportRequest,
  ImportResult,
  NativeSessionMeta,
  PluginCapabilities,
  PluginInitializeParams,
  PluginInitializeResult,
  PluginInstance,
  SessionChunk,
} from "@pi-agent-hub/protocol";
import { PluginError, ensureDir, expandHome, sha256File } from "@pi-agent-hub/sync-plugin-sdk";
import { isRecord, linearize, readSessionFile, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";

/**
 * sync-plugin-pi-web：以 Server API 方式对接独立部署的 pi-web（Next HTTP server）。
 *
 * - collect / read：走磁盘（pi-web 与会话共享 ~/.pi/agent/sessions，jsonl 同源）
 * - deliver / model-info / idle：走 pi-web HTTP API（POST /api/agent/[id]、GET /api/models）
 */
interface PiWebOptions {
  server?: string;
  cwd?: string;
  agentDir?: string;
  password?: string;
}

export class PiWebPlugin {
  private options: PiWebOptions = {};
  private instance: PluginInstance | undefined;
  private workDir = "";

  private readonly capabilities: PluginCapabilities = {
    collect: true,
    deliver: true,
    import: false,
    losslessImport: false,
    exportNative: true,
    controlInterface: "native-api",
    readStrategy: ["api", "storage"],
    deliveryStrategy: ["api"],
    largeReadMode: "temp-file",
    watch: false,
  };

  async initialize(params: PluginInitializeParams): Promise<PluginInitializeResult> {
    const config = isRecord(params.config.options) ? params.config.options : {};
    this.options = {
      server: typeof config.server === "string" ? config.server : undefined,
      cwd: typeof config.cwd === "string" ? config.cwd : undefined,
      agentDir: typeof config.agentDir === "string" ? expandHome(config.agentDir) : undefined,
      password: typeof config.password === "string" ? config.password : undefined,
    };
    const agentDir = this.options.agentDir ?? join(homedir(), ".pi", "agent");
    this.instance = {
      instanceId: `pi-web-${Buffer.from(agentDir).toString("base64url").slice(0, 12)}`,
      displayName: params.config.instance?.name ?? "default",
      homeDir: agentDir,
    };
    this.workDir = params.workDir;
    return { pluginVersion: "0.1.1", protocolVersion: "1.0", capabilities: this.capabilities };
  }

  async detect(): Promise<{ instances: PluginInstance[] }> {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return { instances: [this.instance] };
  }

  private agentDir(): string {
    const home = this.instance?.homeDir;
    if (!home) throw new PluginError("invalid_request", "plugin not initialized");
    return home;
  }

  /** 006：模型信息查询（pi-web GET /api/models?cwd=）。字段映射 ⬜ 以真机响应校准。 */
  async getModelInfo(params: Record<string, unknown>): Promise<{
    agentId: string;
    models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
    currentModel: { provider: string; modelId: string } | null;
    currentThinkingLevel: string | null;
  }> {
    void params;
    const base = this.serverBase();
    if (!base) throw new PluginError("unsupported", "pi-web model info requires options.server (e.g. http://127.0.0.1:30142)");
    const cwd = this.options.cwd ?? (await this.firstSessionCwd()) ?? homedir();
    const headers = this.authHeaders();
    const response = await timeoutFetch(`${base}/api/models?cwd=${encodeURIComponent(cwd)}`, { headers }, 15_000);
    if (!response.ok) {
      throw new PluginError("agent_error", `pi-web models failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const data = (await response.json().catch(() => null)) as {
      modelList?: unknown[];
      defaultModel?: Record<string, unknown>;
      thinkingLevels?: unknown;
      defaultThinkingLevel?: unknown;
    } | null;
    // pi-web thinkingLevels 为 { "provider:modelId": string[] } 映射
    const levelsByModel = (isRecord(data?.thinkingLevels) ? data.thinkingLevels : {}) as Record<string, unknown>;
    const models = Array.isArray(data?.modelList)
      ? data.modelList.map((entry) => {
          const r = isRecord(entry) ? entry : {};
          const provider = typeof r.provider === "string" ? r.provider : "";
          const modelId = typeof r.modelId === "string" ? r.modelId : (typeof r.id === "string" ? r.id : "");
          const levels = levelsByModel[`${provider}:${modelId}`];
          return {
            provider,
            modelId,
            name: typeof r.name === "string" ? r.name : modelId,
            reasoning: true,
            input: Array.isArray(r.input) ? r.input.map(String) : ["text"],
            thinkingLevels: Array.isArray(levels) ? levels.map(String) : [],
          };
        }).filter((model) => model.provider !== "" && model.modelId !== "")
      : [];
    const def = data?.defaultModel;
    const currentModel = def
      ? {
          provider: typeof def.provider === "string" ? def.provider : "",
          modelId: typeof def.modelId === "string" ? def.modelId : (typeof def.id === "string" ? def.id : ""),
        }
      : (models[0] ? { provider: models[0].provider, modelId: models[0].modelId } : null);
    return {
      agentId: this.instance?.instanceId ?? "",
      models,
      currentModel: currentModel && currentModel.modelId ? currentModel : null,
      currentThinkingLevel: typeof data?.defaultThinkingLevel === "string" ? data.defaultThinkingLevel : null,
    };
  }

  /** 007：下发（pi-web POST /api/agent/[id]：可先 set_model / set_thinking_level，再 prompt）。 */
  async deliver(request: DeliverRequest): Promise<DeliverResult> {
    const base = this.serverBase();
    if (!base) throw new PluginError("unsupported", "pi-web delivery requires options.server (e.g. http://127.0.0.1:30142)");
    if (request.model) {
      await this.agentRequest(request.nativeId, {
        type: "set_model",
        provider: request.model.provider,
        modelId: request.model.modelId,
      });
    }
    if (request.thinkingLevel) {
      await this.agentRequest(request.nativeId, {
        type: "set_thinking_level",
        level: request.thinkingLevel,
      });
    }
    const payload: Record<string, unknown> = { type: "prompt", message: request.message };
    const images = request.images ?? [];
    if (images.length > 0) {
      const builtImages: unknown[] = [];
      for (const image of images) {
        const data = image.path ? (await readFile(image.path)).toString("base64") : (image.dataBase64 ?? "");
        builtImages.push({ type: "image", data, mimeType: image.mime ?? "image/png" });
      }
      payload.images = builtImages;
    }
    await this.agentRequest(request.nativeId, payload);
    return { ok: true, state: "completed", warnings: images.length ? ["pi-web image attachments delivered to server"] : undefined };
  }

  private async agentRequest(nativeId: string, body: Record<string, unknown>): Promise<unknown> {
    const base = this.serverBase();
    if (!base) throw new PluginError("unsupported", "pi-web RPC requires options.server");
    const response = await timeoutFetch(`${base}/api/agent/${encodeURIComponent(nativeId)}`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
    if (!response.ok) {
      throw new PluginError("agent_error", `pi-web agent call ${String(body.type)} failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    return response.json().catch(() => null);
  }

  private serverBase(): string {
    return (this.options.server ?? "").replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    if (this.options.password) {
      const encoded = Buffer.from(`pi:${this.options.password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    return {};
  }

  private async firstSessionCwd(): Promise<string | undefined> {
    const sessions = (await this.listSessions()).sessions;
    return sessions.find((session) => session.cwd)?.cwd;
  }

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const sessionsDir = join(this.agentDir(), "sessions");
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(sessionsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(sessionsDir, entry.name));
    } catch {
      return { sessions: [] };
    }
    const sessions: NativeSessionMeta[] = [];
    for (const dir of projectDirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const parsed = await readSessionFile(file);
          const info = await stat(file);
          const last = parsed.entries[parsed.entries.length - 1];
          sessions.push({
            nativeId: parsed.header.id,
            nativePath: file,
            updatedAt: last ? timestampMs(last) : info.mtimeMs,
            title: this.titleOf(parsed.entries),
            cwd: parsed.header.cwd,
            state: "idle",
            entryCount: parsed.entries.length,
          });
        } catch {
          // skip unreadable session files
        }
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions };
  }

  private titleOf(entries: readonly CanonicalEntry[]): string | undefined {
    for (const entry of entries) {
      if (entry.type === "session_info" && typeof entry.name === "string") return entry.name;
    }
    for (const entry of entries) {
      if (entry.type !== "message" || !isRecord(entry.message)) continue;
      if (entry.message.role !== "user") continue;
      if (typeof entry.message.content === "string") return entry.message.content.slice(0, 80);
    }
    return undefined;
  }

  private async findSessionPath(nativeId: string): Promise<string> {
    const sessions = await this.listSessions();
    const found = sessions.sessions.find((session) => session.nativeId === nativeId);
    if (!found?.nativePath) throw new PluginError("not_found", `pi-web session not found: ${nativeId}`);
    return found.nativePath;
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    const lastEntryId = typeof params.lastEntryId === "string" ? params.lastEntryId : undefined;
    const file = await this.findSessionPath(nativeId);
    const parsed = await readSessionFile(file);
    let mode: "delta" | "full" = since === undefined ? "full" : "delta";

    let entries = parsed.entries;
    if (since !== undefined) {
      const lastIndex = lastEntryId ? entries.findIndex((entry) => entry.id === lastEntryId) : -1;
      if (lastIndex >= 0 && lastIndex + 1 < entries.length) {
        const leaf = entries[lastIndex];
        const next = entries[lastIndex + 1];
        if (next.parentId !== leaf.id && timestampMs(next) > since) mode = "full";
      }
      entries = entries.filter((entry, index) => timestampMs(entry) > since || (lastIndex >= 0 && index > lastIndex));
    }

    const output = mode === "full" ? linearize(entries) : entries;
    if (mode === "full") {
      const errors = validateEntries(output);
      if (errors.length > 0 && output.length > 0) {
        throw new PluginError("invalid_output", `invalid pi entry chain: ${errors[0]}`);
      }
    }

    const meta = {
      cwd: parsed.header.cwd,
      title: this.titleOf(parsed.entries),
      createdAt: Date.parse(parsed.header.timestamp),
      updatedAt: output.length > 0 ? timestampMs(output[output.length - 1]!) : Date.parse(parsed.header.timestamp),
      state: "idle" as const,
    };

    const serialized = output.map((entry) => JSON.stringify(entry)).join("\n");
    if (output.length > 2_000 || serialized.length > 4 * 1024 * 1024) {
      await ensureDir(join(this.workDir, "native"));
      const tmp = join(this.workDir, "native", `${nativeId}.ndjson`);
      await writeFile(tmp, serialized + (output.length > 0 ? "\n" : ""), "utf8");
      return {
        mode,
        since,
        entriesPath: tmp,
        count: output.length,
        meta,
      };
    }
    return { mode, since, entries, meta };
  }

  /** 007：空闲检查（pi-web 会话运行态读取 ⬜ 待接 /api/sessions active 字段；默认视为空闲）。 */
  async checkIdle(params: Record<string, unknown>): Promise<{ idle: boolean }> {
    void params;
    return { idle: true };
  }

  async importSession(_request: ImportRequest): Promise<ImportResult> {
    throw new PluginError("unsupported", "pi-web import not wired yet");
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const file = await this.findSessionPath(request.nativeId);
    const nativeDir = join(request.workDir, "native");
    await ensureDir(nativeDir);
    const target = join(nativeDir, `${request.nativeId}.jsonl`);
    await copyFile(file, target);
    const info = await stat(target);
    return {
      nativePath: target,
      format: "pi-jsonl-v3",
      sha256: await sha256File(target),
      bytes: info.size,
    };
  }
}

async function timeoutFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
