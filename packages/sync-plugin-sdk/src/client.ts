import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { encodeLine, isResponse, type JsonRpcFailure, type JsonRpcSuccess } from "./jsonrpc.js";

export interface RpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * 每次（重新）拉起子进程后必须先完成的握手请求（如 initialize）。
   * 子进程崩溃重拉后内存状态全部丢失，不重放握手会让后续请求报「plugin not initialized」。
   */
  handshake?: { method: string; params: unknown; timeoutMs?: number };
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
  /** 当前子进程的握手就绪信号（无 handshake 时已 resolved）。 */
  private ready: Promise<void> = Promise.resolve();

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
    this.closed = false;
    // 插件子进程退出/未读 stdin 时，write 会抛 EPIPE：吞掉该错误，避免 daemon 因未处理
    // 'error' 事件崩溃；在途请求会由下方 child.on('exit') 统一拒绝。
    child.stdin.on("error", () => {
      /* EPIPE handled via exit path */
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line) this.options.onLog?.(line);
      }
    });
    const fail = (error: Error): void => {
      // 必须清掉 this.child：否则 request() 会误以为插件仍在运行，持续向死进程 stdin 写入，
      // 每次调用都只能等到超时（表现为 list_sessions 终身超时）。
      if (this.child === child) this.child = undefined;
      this.closed = true;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    };
    child.on("error", (error) => {
      this.options.onLog?.(`[rpc] plugin spawn/write error: ${String(error)}`);
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      this.options.onLog?.(`[rpc] plugin exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      fail(new Error(`plugin exited code=${code ?? "null"} signal=${signal ?? "null"}`));
    });

    // 每次（重新）启动都要跑一遍握手，否则重拉后的子进程没有 initialize 状态。
    const handshake = this.options.handshake;
    if (handshake) {
      this.ready = this.send<void>(child, handshake.method, handshake.params, handshake.timeoutMs ?? 20_000);
      // request() 会 await 它；此处单独 catch 只为避免「无等待者时」产生 unhandled rejection。
      void this.ready.catch(() => undefined);
    } else {
      this.ready = Promise.resolve();
    }
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

  async request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.closed) this.start();
    await this.ready;
    const child = this.child;
    if (!child) throw new Error("plugin not started");
    return this.send<T>(child, method, params, timeoutMs);
  }

  /** 发送一次 JSON-RPC 请求（不处理握手，调用方需先 await ready）。 */
  private send<T>(child: ChildProcessWithoutNullStreams, method: string, params: unknown, timeoutMs: number): Promise<T> {
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
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
