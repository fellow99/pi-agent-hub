import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DeliverImageUrl,
  DeliverRequest,
  DeliverResult,
  ModelInfoResult,
} from "@pi-agent-hub/protocol";
import type { HubClient } from "./hub-client.js";
import type { PluginManager, AgentRuntime } from "./plugin-manager.js";
import type { Logger } from "./logger.js";

/**
 * 007 下发执行器（daemon 侧）。
 *
 * 职责：同一 native session 串行（C-1 单写者）· 本地幂等表 · 空闲/冲突检查 ·
 * 图片下载 · 携带 model/thinkingLevel/images 调插件 deliver · ack/result · 结果后触发会话同步。
 *
 * ALSO 006：模型信息请求路由（同文件便于共享 manager/hub/logger 依赖）。
 */

export interface DeliverExecutorDeps {
  hub: HubClient;
  manager: PluginManager;
  logger: Logger;
  /** 图片临时文件工作目录。 */
  workDir: string;
  /** 幂等表落盘目录。 */
  stateDir: string;
}

interface DoneEntry {
  id: string;
  result?: { state: string; nativeMessageId?: string; warnings?: string[] };
  at: number;
}

export class DeliverExecutor {
  private readonly chains = new Map<string, Promise<unknown>>();
  private done = new Map<string, DoneEntry>();

  constructor(private readonly deps: DeliverExecutorDeps) {}

  async init(): Promise<void> {
    try {
      const raw = await readFile(join(this.deps.stateDir, "deliveries-done.json"), "utf8");
      const parsed = JSON.parse(raw) as DoneEntry[];
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        if (entry && entry.id) this.done.set(entry.id, entry);
      }
    } catch {
      // 首次运行无常驻文件
    }
  }

  async handleModelInfo(data: Record<string, unknown>): Promise<void> {
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    const agentId = typeof data.agentId === "string" ? data.agentId : "";
    const nativeSessionId = typeof data.nativeSessionId === "string" ? data.nativeSessionId : "";
    if (!requestId || !agentId || !nativeSessionId) {
      await this.deps.logger.warn("malformed model_info_request ignored", data);
      return;
    }
    const runtime = this.deps.manager.list().find((candidate) => candidate.agentId === agentId);
    if (!runtime) {
      await this.deps.hub.modelInfoResult(requestId, { ok: false, error: { code: "agent_unsupported", message: "agent not found" } });
      return;
    }
    try {
      await this.deps.hub.modelInfoAck(requestId);
    } catch (error) {
      await this.deps.logger.warn("model-info ack failed, continue", { requestId, error: String(error) });
    }
    try {
      const result = await runtime.client.request<ModelInfoResult>("get_model_info", {
        instanceId: runtime.instanceId,
        nativeId: nativeSessionId,
      }, 30_000);
      await this.deps.hub.modelInfoResult(requestId, { ok: true, result });
    } catch (error) {
      const code = toModelInfoErrorCode(error);
      await this.deps.hub.modelInfoResult(requestId, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
      await this.deps.logger.warn("model-info failed", { requestId, code });
    }
  }

  async execute(
    data: Record<string, unknown>,
    afterDeliver: (runtime: AgentRuntime, nativeSessionId: string) => Promise<void>,
  ): Promise<void> {
    const deliveryId = typeof data.deliveryId === "string" ? data.deliveryId : "";
    const agentId = typeof data.agentId === "string" ? data.agentId : "";
    const nativeSessionId = typeof data.nativeSessionId === "string" ? data.nativeSessionId : "";
    if (!deliveryId || !agentId || !nativeSessionId) {
      await this.deps.logger.warn("malformed deliver event ignored", data);
      return;
    }
    const runtime = this.deps.manager.list().find((candidate) => candidate.agentId === agentId);
    if (!runtime) return;
    // 幂等：本地已完成表命中 → 直接回原结果。
    if (this.done.has(deliveryId)) {
      const cached = this.done.get(deliveryId)!;
      await this.deps.hub.deliveryResult(deliveryId, { ok: true, result: cached.result ?? { state: "completed" } });
      return;
    }
    const key = `${agentId}\0${nativeSessionId}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const task = previous
      .then(() => this.doDeliver(runtime, deliveryId, nativeSessionId, data, afterDeliver))
      .catch((error) => this.deps.logger.error("deliver task failed", { deliveryId, error: String(error) }));
    this.chains.set(key, task);
    await task;
  }

  private async doDeliver(
    runtime: AgentRuntime,
    deliveryId: string,
    nativeSessionId: string,
    data: Record<string, unknown>,
    afterDeliver: (runtime: AgentRuntime, nativeSessionId: string) => Promise<void>,
  ): Promise<void> {
    const message = typeof data.message === "string" ? data.message : "";
    const force = data.force === true || data.policy === "force";
    const images: DeliverImageUrl[] = Array.isArray(data.images) ? data.images.slice(0, 10) : [];

    // 空闲/冲突检查（C-1 单写者）：仅 idle-only 且插件支持 check_idle。
    if (!force && runtime.capabilities.controlInterface === "native-api") {
      try {
        const idle = await runtime.client.request<{ idle: boolean }>("check_idle", { nativeId: nativeSessionId }, 15_000);
        if (idle.idle === false) {
          await this.deps.hub.deliveryResult(deliveryId, { ok: false, error: { code: "conflict", message: "session is busy", retryable: false } });
          return;
        }
      } catch {
        // check_idle 未实现或失败 → 不拦截（首版宽松执行；warnings 由插件侧可补）。
      }
    }

    try {
      await this.deps.hub.ack(deliveryId);
    } catch (error) {
      await this.deps.logger.warn("deliver ack failed, continue", { deliveryId, error: String(error) });
    }

    // 下载图片到临时文件 → 插件收 mime/path。
    const imageInputs: Array<{ mime: string; path: string }> = [];
    const imageDir = join(this.deps.workDir, "deliveries", deliveryId, "images");
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]!;
      const dest = join(imageDir, String(index));
      try {
        await this.deps.hub.downloadDeliveryImage(deliveryId, index, dest, image.sha256);
        imageInputs.push({ mime: image.mime, path: dest });
      } catch (error) {
        await this.deps.logger.warn("deliver image download failed", { deliveryId, index, error: String(error) });
      }
    }

    const request: DeliverRequest = {
      deliveryId,
      instanceId: runtime.instanceId,
      nativeId: nativeSessionId,
      message,
      images: imageInputs,
      model: data.model ? normalizeModel(data.model) : null,
      thinkingLevel: typeof data.thinkingLevel === "string" && data.thinkingLevel.length > 0 ? data.thinkingLevel : null,
      policy: data.policy === "force" ? "force" : "idle-only",
      force,
    };
    try {
      const result = await runtime.client.request<DeliverResult>("deliver", request, 15 * 60_000);
      await this.deps.hub.deliveryResult(deliveryId, {
        ok: true,
        result: { state: result.state, nativeMessageId: result.nativeMessageId, warnings: result.warnings },
      });
      this.done.set(deliveryId, { id: deliveryId, result: { state: result.state, nativeMessageId: result.nativeMessageId, warnings: result.warnings }, at: Date.now() });
      await this.persistDone();
      if (result.ok) {
        await afterDeliver(runtime, nativeSessionId).catch((error) =>
          this.deps.logger.warn("post-deliver sync failed", { deliveryId, error: String(error) }));
      }
    } catch (error) {
      const code = toDeliverErrorCode(error);
      await this.deps.hub.deliveryResult(deliveryId, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error), retryable: false } });
      await this.deps.logger.warn("deliver failed", { deliveryId, code });
    } finally {
      await rm(imageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async persistDone(): Promise<void> {
    await mkdir(this.deps.stateDir, { recursive: true });
    const recent = [...this.done.values()].filter((entry) => Date.now() - entry.at < 7 * 24 * 3600_000);
    await writeFile(join(this.deps.stateDir, "deliveries-done.json"), JSON.stringify(recent), "utf8");
  }
}

function normalizeModel(value: unknown): { provider: string; modelId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.modelId !== "string") return null;
  return { provider: record.provider, modelId: record.modelId };
}

function toModelInfoErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("method not found") || message.includes("agent not found")) return "agent_unsupported";
  if (message.includes("not found")) return "not_found";
  return "agent_error";
}

function toDeliverErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Model not found") || message.includes("model_not_found")) return "model_not_found";
  if (message.includes("method not found") || message.includes("unsupported")) return "unsupported";
  return "agent_error";
}
