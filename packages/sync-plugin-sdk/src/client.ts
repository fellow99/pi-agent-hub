import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { encodeLine, isResponse, type JsonRpcFailure, type JsonRpcSuccess } from "./jsonrpc.js";

export interface RpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: unknown) => void;
  onLog?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string | number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: RpcClientOptions) {}

  start(): void {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line) this.options.onLog?.(line);
      }
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`plugin exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
  }

  private handleLine(line: string): void {
    const raw = line.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.onLog?.(`invalid json from plugin: ${raw.slice(0, 200)}`);
      return;
    }
    if (!isResponse(parsed)) {
      const method = (parsed as { method?: unknown }).method;
      if (typeof method === "string") {
        this.options.onNotification?.(method, (parsed as { params?: unknown }).params);
      }
      return;
    }
    if (parsed.id === null) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    if ("error" in parsed) {
      const failure = parsed as JsonRpcFailure;
      const data = failure.error.data as { code?: unknown } | undefined;
      const error = new Error(failure.error.message) as Error & { code?: string };
      error.code = typeof data?.code === "string" ? data.code : "internal";
      pending.reject(error);
    } else {
      pending.resolve((parsed as JsonRpcSuccess).result);
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.closed) this.start();
    const child = this.child;
    if (!child) return Promise.reject(new Error("plugin not started"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`plugin request timeout: ${method}`), { code: "timeout" }));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.stdin.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.child?.stdin.write(encodeLine({ jsonrpc: "2.0", method, params }));
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) return;
    try {
      await this.request("shutdown", {}, 5_000);
    } catch {
      // ignore shutdown failures; kill below
    }
    this.closed = true;
    this.child.kill();
  }
}
