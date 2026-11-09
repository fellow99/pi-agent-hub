#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHubConfig } from "./config.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const loaded = await loadHubConfig(process.argv[2]);
  const consoleDir = resolve(process.env.HUB_CONSOLE_DIR
    ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hub-console", "dist"));
  const app = createApp({ config: loaded.config, dataDir: loaded.dataDir, consoleDir });
  const port = loaded.config.server?.port ?? Number(process.env.PORT ?? 8443);
  const host = loaded.config.server?.hostname ?? "127.0.0.1";
  app.listen(port, host, () => {
    process.stdout.write(`pi-agent-hub listening on http://${host}:${port}\n`);
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`hub-service failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
