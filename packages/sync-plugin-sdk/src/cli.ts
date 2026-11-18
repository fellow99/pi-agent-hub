import { spawn, type ChildProcess } from "node:child_process";

/**
 * CLI 工具：供「基于 CLI 调用方式」的插件（sync-plugin-pi-cli / sync-plugin-opencode-cli）
 * spawn agent CLI 命令并收集输出，统一超时与退出码处理。
 */

export interface RunCliOptions {
  /** 工作目录（插件内通常是会话 cwd）。 */
  cwd?: string;
  /** 环境变量覆盖。 */
  env?: NodeJS.ProcessEnv;
  /** 超时 ms；超时 kill 并以 code:"timeout" 拒绝。默认 30_000。 */
  timeoutMs?: number;
  /** 单次收集输出上限（字节），超出即截断；默认 16 MiB。 */
  maxBytes?: number;
}

export interface CliResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** stdout 是否被 maxBytes 截断。 */
  truncated: boolean;
}

type CliStdio = ChildProcess & {
  stdout: import("node:stream").Readable;
  stderr: import("node:stream").Readable;
};

export async function runCli(
  command: string,
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const { cwd, env, timeoutMs = 30_000, maxBytes = 16 * 1024 * 1024 } = options;
  const child: CliStdio = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return await new Promise<CliResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let killedTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      // 超时：记录状态，先 SIGTERM，等待 close；短宽限后仍未退出再 SIGKILL，避免孤儿后台进程。
      timedOut = true;
      child.kill();
      killedTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出则忽略
        }
      }, 2_000);
    }, timeoutMs);

    function pushStdout(chunk: Buffer): void {
      const remaining = maxBytes - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.subarray(0, remaining);
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
      if (chunk.length > remaining) truncated = true;
    }

    function pushStderr(chunk: Buffer): void {
      const remaining = maxBytes - stderrBytes;
      if (remaining <= 0) return;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.subarray(0, remaining).length;
    }

    function cleanup(): void {
      clearTimeout(timer);
      if (killedTimer) clearTimeout(killedTimer);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
    }

    function settleFail(error: Error & { code?: string }, code = "agent_error"): void {
      if (settled) return;
      settled = true;
      cleanup();
      Object.assign(error, { code });
      reject(error);
    }

    function settleOk(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: child.exitCode,
        signal: child.signalCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated,
      });
    }

    child.stdout.on("data", (chunk: Buffer) => pushStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => pushStderr(chunk));
    child.on("error", (error) => settleFail(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        // 超时后子进程已关闭：以 timeout 归一（不受后续 close 竞态影响）。
        settleFail(new Error(`cli timeout after ${timeoutMs}ms: ${command} ${args[0] ?? ""}`), "timeout");
        return;
      }
      if (code === null && signal !== null) {
        settleFail(new Error(`cli killed by signal ${signal}: ${command}`), "agent_error");
        return;
      }
      settleOk();
    });
  });
}
