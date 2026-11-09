#!/usr/bin/env node
import { runPluginServer } from "@pi-agent-hub/sync-plugin-sdk";
import type {
  DeliverRequest,
  ExportNativeRequest,
  ImportRequest,
  PluginInitializeParams,
  PluginInitializeResult,
} from "@pi-agent-hub/protocol";
import { OpencodePlugin } from "./plugin.js";

const plugin = new OpencodePlugin();

runPluginServer({
  initialize: (params) => plugin.initialize(params as unknown as PluginInitializeParams) as Promise<PluginInitializeResult>,
  detect: () => plugin.detect(),
  list_sessions: () => plugin.listSessions(),
  read_session: (params) => plugin.readSession(params),
  deliver: (params) => plugin.deliver(params as unknown as DeliverRequest),
  import_session: (params) => plugin.importSession(params as unknown as ImportRequest),
  export_native: (params) => plugin.exportNative(params as unknown as ExportNativeRequest),
  ping: () => ({ pong: true, uptimeMs: Math.round(process.uptime() * 1000) }),
  shutdown: () => ({}),
});
