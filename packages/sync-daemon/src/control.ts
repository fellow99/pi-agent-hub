import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";

export interface ControlState {
  paused: boolean;
  status: () => unknown;
  syncNow: () => Promise<void>;
  logs: (tail: number) => Promise<string>;
  quit: () => void;
}

export async function startControlServer(
  state: ControlState,
  dataDir: string,
  logger: Logger,
): Promise<Server> {
  const token = randomBytes(24).toString("base64url");
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/local/status") {
        json(response, 200, { paused: state.paused, ...(typeof state.status() === "object" ? state.status() as object : {}) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/local/pause") {
        state.paused = true;
        json(response, 200, { paused: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/local/resume") {
        state.paused = false;
        json(response, 200, { paused: false });
        return;
      }
      if (request.method === "POST" && url.pathname === "/local/sync-now") {
        await state.syncNow();
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/local/logs") {
        json(response, 200, { text: await state.logs(Number(url.searchParams.get("tail") ?? "100")) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/local/quit") {
        state.quit();
        json(response, 200, { ok: true });
        return;
      }
      response.writeHead(404).end("not found");
    } catch (error) {
      await logger.error("control request failed", { error: String(error) });
      json(response, 500, { error: String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const path = join(dataDir, "daemon-control.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ port, token }), { encoding: "utf8", mode: 0o600 });
  await logger.info("control server ready", { port });
  return server;
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
