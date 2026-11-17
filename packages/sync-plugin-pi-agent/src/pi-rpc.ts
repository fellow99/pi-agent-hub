import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { THINKING_LEVELS } from "@pi-agent-hub/protocol";

export interface PiPromptOptions {
  command: string;
  sessionPath: string;
  agentDir: string;
  message: string;
  /** 图片：插件已把 hub 下载的临时文件路径传进来。 */
  images?: Array<{ mime: string; path: string }>;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  timeoutMs?: number;
}

interface PiRecord {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
}

/** 会话状态（get_state 的投影）。 */
interface PiState {
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
}

/** 可用模型快照中的一项（仅投影需要的字段）。 */
interface PiModelLike {
  provider?: string;
  id?: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  thinkingLevelMap?: Record<string, string | null>;
}

/** 模型支持档位：与 pi `getSupportedThinkingLevels` 同语义（!reasoning → ["off"]；null 映射排除；xhigh/max 需显式映射）。 */
export function supportedThinkingLevels(model: PiModelLike): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** 006：查询模型信息（get_available_models + get_available_thinking_levels + get_state）。 */
export async function queryModelInfo(options: {
  command: string;
  sessionPath: string;
  agentDir: string;
  timeoutMs?: number;
}): Promise<{
  models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
  currentModel: { provider: string; modelId: string } | null;
  currentThinkingLevel: string | null;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(options.command, ["--mode", "rpc", "--session", options.sessionPath], {
    cwd: dirname(options.sessionPath),
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (value: unknown): void => { child.stdin.write(JSON.stringify(value) + "\n"); };

  return await new Promise((resolve, reject) => {
    const models: PiModelLike[] = [];
    let currentModel: PiModelLike | null = null;
    let currentThinkingLevel: string | null = null;
    let finished = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("pi get_model_info timeout")); }, timeoutMs);

    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rl.close();
      child.stdin.end();
      setTimeout(() => child.kill(), 1_000);
      if (error) { reject(error); return; }
      resolve({
        models: models.map((model) => ({
          provider: model.provider ?? "",
          modelId: model.id ?? "",
          name: model.name ?? model.id ?? "",
          reasoning: model.reasoning ?? false,
          input: Array.isArray(model.input) ? [...model.input] : [],
          thinkingLevels: supportedThinkingLevels(model),
        })),
        currentModel: currentModel ? { provider: currentModel.provider ?? "", modelId: currentModel.id ?? "" } : null,
        currentThinkingLevel,
      });
    };

    rl.on("line", (line) => {
      let record: PiRecord;
      try { record = JSON.parse(line) as PiRecord; } catch { return; }
      const data = record.data as Record<string, unknown> | undefined;
      if (record.type === "response" && record.command === "get_available_models" && record.success) {
        const list = Array.isArray(data?.models) ? data.models as PiModelLike[] : [];
        models.push(...list);
        send({ id: "t-1", type: "get_available_thinking_levels" });
        return;
      }
      if (record.type === "response" && record.command === "get_available_thinking_levels" && record.success) {
        // pi 返回当前模型的可用档位（会话级默认档位视图）；本实现以每模型 thinkingLevelMap 投影为准，
        // 该响应仅用于保留当前档位候选，不覆盖投影结果。
        send({ id: "s-1", type: "get_state" });
        return;
      }
      if (record.type === "response" && record.command === "get_state" && record.success) {
        const state = data as unknown as PiState;
        currentModel = state.model ?? null;
        currentThinkingLevel = typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
        finish();
        return;
      }
      if (record.type === "response" && !record.success) {
        finish(new Error(record.error ?? "pi get_model_info command failed"));
      }
    });

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!finished) finish(new Error(`pi exited before get_model_info settle (code=${code ?? "null"})`));
    });

    send({ id: "m-1", type: "get_available_models" });
  });
}

/** 007：下发 prompt（get_state → set_model? → set_thinking_level? → prompt + images）。 */
export async function promptPiSession(options: PiPromptOptions): Promise<void> {
  const child = spawn(options.command, ["--mode", "rpc", "--session", options.sessionPath], {
    cwd: dirname(options.sessionPath),
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let settled = false;
  let finished = false;

  const send = (value: unknown): void => {
    child.stdin.write(JSON.stringify(value) + "\n");
  };

  return await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`pi prompt timeout after ${timeoutMs}ms`)); }, timeoutMs);

    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rl.close();
      child.stdin.end();
      setTimeout(() => child.kill(), 1_000);
      if (error) reject(error);
      else resolve();
    };

    rl.on("line", (line) => {
      let record: PiRecord;
      try { record = JSON.parse(line) as PiRecord; } catch { return; }

      if (record.type === "response" && record.command === "get_state" && record.success && !finished) {
        const state = record.data as unknown as PiState;
        // model 与当前不一致才 set_model；失败（模型不存在）→ 拒绝 prompt。
        if (options.model && state.model
          && (state.model.provider !== options.model.provider || state.model.id !== options.model.modelId)) {
          send({ id: "setm-1", type: "set_model", provider: options.model.provider, modelId: options.model.modelId });
          return;
        }
        if (options.thinkingLevel && options.thinkingLevel !== state.thinkingLevel) {
          send({ id: "sett-1", type: "set_thinking_level", level: options.thinkingLevel });
          return;
        }
        void sendPrompt();
        return;
      }

      if (record.type === "response" && record.command === "set_model") {
        if (!record.success) { finish(new Error(record.error ?? "pi rejected set_model")); return; }
        if (options.thinkingLevel) send({ id: "sett-1", type: "set_thinking_level", level: options.thinkingLevel });
        else void sendPrompt();
        return;
      }

      if (record.type === "response" && record.command === "set_thinking_level") {
        if (!record.success) { finish(new Error(record.error ?? "pi rejected set_thinking_level")); return; }
        void sendPrompt();
        return;
      }

      if (record.type === "response" && record.command === "prompt") {
        if (!record.success) finish(new Error(record.error ?? "pi rejected prompt"));
        return;
      }
      if (record.type === "agent_settled") {
        settled = true;
        finish();
      }
    });

    const sendPrompt = (): void => {
      void buildImageContents(options.images).then((images) => {
        if (finished) return;
        send({ id: "prompt-1", type: "prompt", message: options.message, images: images.length ? images : undefined });
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    };

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled && !finished) finish(new Error(`pi exited before settle (code=${code ?? "null"})`));
    });

    send({ id: "state-1", type: "get_state" });
  });
}

async function buildImageContents(images: Array<{ mime: string; path: string }> | undefined): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  if (!images || images.length === 0) return [];
  const output: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const image of images) {
    const buffer = await readFile(image.path);
    output.push({ type: "image", data: buffer.toString("base64"), mimeType: image.mime });
  }
  return output;
}
