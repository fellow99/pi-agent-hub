import { appendFile, mkdir } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Logger {
  constructor(private readonly filePath?: string) {}

  async init(): Promise<void> {
    if (this.filePath) await mkdir(dirname(this.filePath), { recursive: true });
  }

  async info(message: string, detail?: unknown): Promise<void> {
    await this.write("info", message, detail);
  }

  async warn(message: string, detail?: unknown): Promise<void> {
    await this.write("warn", message, detail);
  }

  async error(message: string, detail?: unknown): Promise<void> {
    await this.write("error", message, detail);
  }

  /**
   * 崩溃落盘：进程即将退出，异步 append 不保证写完，故用同步写。
   *
   * 托盘以 CREATE_NO_WINDOW 启动整条链（starter -> daemon），stderr 没有控制台可写、
   * 会被直接丢弃；崩溃栈若不落到日志文件，「同步状态变已停止」将无从排查。
   */
  crashSync(message: string, detail?: unknown): void {
    const line = `${new Date().toISOString()} error ${message}${suffixOf(detail)}`;
    try {
      process.stderr.write(line + "\n");
    } catch {
      // 无控制台时 stderr 可能不可写
    }
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line + "\n", "utf8");
    } catch {
      // 落盘失败也不能阻塞退出
    }
  }

  private async write(level: string, message: string, detail?: unknown): Promise<void> {
    const line = `${new Date().toISOString()} ${level} ${message}${suffixOf(detail)}`;
    process.stderr.write(line + "\n");
    if (this.filePath) {
      try {
        await appendFile(this.filePath, line + "\n", "utf8");
      } catch {
        // logging must never crash the daemon
      }
    }
  }
}

/** detail 序列化：循环引用/不可序列化时退化为 String，日志写入不得抛错。 */
function suffixOf(detail: unknown): string {
  if (detail === undefined) return "";
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    try {
      return ` ${String(detail)}`;
    } catch {
      return "";
    }
  }
}
