import { createInterface } from "node:readline";
import { encodeLine, isRequest, type JsonRpcFailure, type JsonRpcSuccess } from "./jsonrpc.js";
import { toPluginError } from "./errors.js";

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

function write(value: unknown): void {
  process.stdout.write(encodeLine(value));
}

function stderr(message: string, detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  process.stderr.write(`[plugin] ${message}${suffix}\n`);
}

export function sendNotification(method: string, params: unknown): void {
  write({ jsonrpc: "2.0", method, params });
}

export function runPluginServer(handlers: Record<string, MethodHandler>): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const raw = line.trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      stderr("invalid json line", { error: String(error) });
      return;
    }
    if (!isRequest(parsed)) return;

    const request = parsed;
    const handler = handlers[request.method];
    if (!handler) {
      write({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32601, message: `method not found: ${request.method}` },
      } satisfies JsonRpcFailure);
      return;
    }

    void Promise.resolve()
      .then(() => handler((request.params ?? {}) as Record<string, unknown>))
      .then((result) => {
        if (request.id === undefined) return;
        write({ jsonrpc: "2.0", id: request.id, result } satisfies JsonRpcSuccess);
        if (request.method === "shutdown") {
          setTimeout(() => process.exit(0), 0);
        }
      })
      .catch((error: unknown) => {
        const pluginError = toPluginError(error);
        stderr("handler failed", { method: request.method, code: pluginError.code, message: pluginError.message });
        if (request.id === undefined) return;
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: pluginError.message,
            data: { code: pluginError.code, retryable: pluginError.code === "timeout" },
          },
        } satisfies JsonRpcFailure);
      });
  });
}
