import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

export interface PiPromptOptions {
  command: string;
  sessionPath: string;
  agentDir: string;
  message: string;
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
  let accepted = false;
  let finished = false;

  const send = (value: unknown): void => {
    child.stdin.write(JSON.stringify(value) + "\n");
  };

  return await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pi prompt timeout after ${timeoutMs}ms`));
    }, timeoutMs);

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
      try {
        record = JSON.parse(line) as PiRecord;
      } catch {
        return;
      }
      if (record.type === "response" && record.command === "get_state" && record.success && !accepted) {
        send({ id: "prompt-1", type: "prompt", message: options.message });
        return;
      }
      if (record.type === "response" && record.command === "prompt") {
        if (record.success) accepted = true;
        else finish(new Error(record.error ?? "pi rejected prompt"));
        return;
      }
      if (record.type === "agent_settled") {
        settled = true;
        finish();
      }
    });

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`pi exited before settle (code=${code ?? "null"})`));
    });

    send({ id: "state-1", type: "get_state" });
  });
}
