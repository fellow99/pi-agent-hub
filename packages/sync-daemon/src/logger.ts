import { appendFile, mkdir } from "node:fs/promises";
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

  private async write(level: string, message: string, detail?: unknown): Promise<void> {
    const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
    const line = `${new Date().toISOString()} ${level} ${message}${suffix}`;
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
