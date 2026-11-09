import express, { type NextFunction, type Request, type Response } from "express";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CanonicalEntry,
  DaemonTokenConfig,
  HubConfig,
  ManifestRequest,
  ManifestResponse,
  ManifestSessionResult,
  SyncRequest,
  UserRole,
} from "@pi-agent-hub/protocol";
import { Store, type SessionRow } from "./db.js";
import { SessionStore } from "./session-store.js";
import { SseHub } from "./sse.js";
import { createSession, deleteSession, getCsrfToken, getSession, hashToken, tokenMatches, verifyUser, type ConsoleUser } from "./auth.js";

interface AuthedRequest extends Request {
  consoleUser?: ConsoleUser;
  daemon?: DaemonTokenConfig;
}

export interface AppOptions {
  config: HubConfig;
  dataDir: string;
  consoleDir?: string;
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const store = new Store(options.dataDir);
  const sessions = new SessionStore(store, options.dataDir);
  const sse = new SseHub();
  const deliveries = new Map<string, { hostId: string; sessionId: string; state: string; createdAt: number }>();
  const hostByToken = new Map<string, DaemonTokenConfig>();
  for (const token of options.config.daemonTokens) {
    hostByToken.set(token.tokenHash ?? hashToken(token.token ?? ""), token);
  }

  app.use(express.json({ limit: "16mb" }));

  app.post("/api/hub/auth/login", (req, res) => {
    const body = req.body as { username?: unknown; password?: unknown };
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      res.status(400).json({ error: { code: "invalid_request", message: "username/password required" } });
      return;
    }
    const user = options.config.users.find((candidate) => candidate.username === body.username);
    if (!user || !verifyUser(user, body.password)) {
      res.status(401).json({ error: { code: "invalid_credentials", message: "invalid username or password" } });
      return;
    }
    const session = createSession({ username: user.username, role: user.role });
    res.setHeader("Set-Cookie", `hub_session=${session.sessionId}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ username: user.username, role: user.role, csrfToken: session.csrfToken });
  });

  app.post("/api/hub/auth/logout", (req, res) => {
    const sessionId = cookie(req, "hub_session");
    if (sessionId) deleteSession(sessionId);
    res.setHeader("Set-Cookie", "hub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  app.use("/api/hub", (req, res, next) => {
    const sessionId = cookie(req, "hub_session");
    const user = getSession(sessionId);
    if (!user) {
      res.status(401).json({ error: { code: "unauthorized", message: "login required" } });
      return;
    }
    (req as AuthedRequest).consoleUser = user;
    if (req.method !== "GET") {
      const csrf = req.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !sessionId || csrf !== getCsrfToken(sessionId)) {
        res.status(403).json({ error: { code: "csrf_failed", message: "invalid csrf token" } });
        return;
      }
      if (user.role !== "admin") {
        res.status(403).json({ error: { code: "forbidden_role", message: "admin role required" } });
        return;
      }
    }
    next();
  });

  app.use("/api/v1", (req, res, next) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: { code: "token_unknown", message: "missing bearer token" } });
      return;
    }
    const token = header.slice("Bearer ".length);
    const host = hostByToken.get(hashToken(token))
      ?? [...hostByToken.values()].find((candidate) => candidate.token === token);
    if (!host) {
      res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } });
      return;
    }
    (req as AuthedRequest).daemon = host;
    next();
  });

  app.get("/api/v1/meta", (_req, res) => {
    res.json({
      apiVersion: 1,
      minDaemonVersion: "0.1.0",
      serverTime: Date.now(),
      capabilities: { sse: true, uploads: false, compression: "gzip" },
      limits: { manifestSessionsPerRequest: 5000, syncEntriesPerRequest: 5000, maxInlineBytes: 16 * 1024 * 1024, maxUploadBytes: 128 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024, maxSessionBytes: 32 * 1024 * 1024 },
    });
  });

  app.post("/api/v1/sync/manifest", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) {
      res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } });
      return;
    }
    const body = req.body as ManifestRequest;
    const results: ManifestSessionResult[] = [];
    for (const agent of body.agents ?? []) {
      for (const session of agent.sessions ?? []) {
        const id = sessions.hubSessionId(daemon.name, agent.agentId, session.nativeId);
        const existing = store.getByNative(agent.agentId, session.nativeId);
        if (!existing) {
          const row: SessionRow = {
            id, host_id: daemon.name, agent_id: agent.agentId, native_id: session.nativeId,
            native_path: null, cwd: session.cwd ?? "", title: session.title ?? null,
            created_at: session.updatedAt, updated_at: 0, last_timestamp: null, last_entry_id: null,
            entry_count: 0, bytes: 0, state: session.state ?? "idle", imported_from: null,
          };
          store.upsertSession(row);
          results.push({ agentId: agent.agentId, nativeId: session.nativeId, hubSessionId: id, lastTimestamp: null, lastEntryId: null, status: "new" });
          continue;
        }
        const status = existing.updated_at === session.updatedAt ? "skipped" : "ok";
        results.push({
          agentId: agent.agentId,
          nativeId: session.nativeId,
          hubSessionId: existing.id,
          lastTimestamp: existing.last_timestamp,
          lastEntryId: existing.last_entry_id,
          status,
          entryCount: existing.entry_count,
        });
      }
    }
    res.json({ serverTime: Date.now(), sessions: results } satisfies ManifestResponse);
  });

  app.post("/api/v1/sync/sessions/:id", async (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) {
      res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } });
      return;
    }
    const id = req.params.id;
    const row = store.getSession(id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    try {
      const body = req.body as SyncRequest;
      if (body.mode === "delta" && typeof body.since === "number") {
        const before = (body.entries ?? []).filter((entry) => Date.parse(entry.timestamp) < body.since!);
        if (before.length > 0) {
          res.status(422).json({ error: { code: "entry_before_since", message: "entry timestamp before since" } });
          return;
        }
      }
      const result = await sessions.sync(row, body);
      res.json({ hubSessionId: id, ...result, status: "ok" });
    } catch (error) {
      res.status(422).json({ error: { code: "invalid_entry", message: String(error) } });
    }
  });

  app.get("/api/v1/events", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) {
      res.status(401).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    sse.add(daemon.name, res);
  });

  app.post("/api/v1/deliveries/:id/ack", (req, res) => {
    const delivery = deliveries.get(req.params.id);
    if (delivery) delivery.state = "accepted";
    res.json({ ok: true });
  });

  app.post("/api/v1/deliveries/:id/result", (req, res) => {
    const delivery = deliveries.get(req.params.id);
    if (delivery) {
      const body = req.body as { ok?: unknown };
      delivery.state = body.ok === true ? "completed" : "failed";
    }
    res.json({ ok: true });
  });

  app.post("/api/v1/imports/:id/result", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/v1/exports/:id/result", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/hub/health", (_req, res) => {
    res.json({ db: true, mirror: true, sse: sse.size(), console: true, version: "0.1.0" });
  });

  app.get("/api/hub/hosts", (req, res) => {
    const host = (req as AuthedRequest).daemon;
    res.json({ items: options.config.daemonTokens.map((token) => ({ id: token.name, name: token.hostName, labels: token.labels ?? [] })), nextCursor: null });
  });

  app.get("/api/hub/tokens", (_req, res) => {
    res.json({ items: options.config.daemonTokens.map((token) => ({ name: token.name, hostName: token.hostName, token: "***" })) });
  });

  app.get("/api/hub/agents", (_req, res) => {
    res.json({ items: [] });
  });

  app.get("/api/hub/sessions", (_req, res) => {
    res.json({ items: store.listSessions().map((row) => sessions.summary(row)), nextCursor: null });
  });

  app.get("/api/hub/sessions/:id", (req, res) => {
    const row = store.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    res.json(sessions.summary(row));
  });

  app.get("/api/hub/sessions/:id/transcript", async (req, res) => {
    const tail = Math.min(Number(req.query.tail ?? 100) || 100, 500);
    const before = req.query.before ? Number(req.query.before) : undefined;
    res.json(await sessions.transcript(req.params.id, tail, before));
  });

  app.get("/api/hub/sessions/:id/blocks/:seq/raw", async (req, res) => {
    const entry = await sessions.readEntry(req.params.id, Number(req.params.seq));
    if (!entry) {
      res.status(404).end();
      return;
    }
    res.type("text/plain").send(JSON.stringify(entry, null, 2));
  });

  app.get("/api/hub/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q) {
      res.status(400).json({ error: { code: "invalid_query", message: "q required" } });
      return;
    }
    const rows = store.listSessions().filter((row) => (row.title ?? "").includes(q) || row.cwd.includes(q));
    res.json({ items: rows.map((row) => ({ sessionId: row.id, seq: 0, entryId: "", snippet: row.title ?? row.cwd, ts: row.updated_at, hostId: row.host_id, agentKind: row.agent_id, title: row.title })), nextCursor: null });
  });

  app.post("/api/hub/deliveries", (req, res) => {
    const body = req.body as { sessionId?: unknown; text?: unknown; policy?: unknown };
    if (typeof body.sessionId !== "string" || typeof body.text !== "string") {
      res.status(400).json({ error: { code: "invalid_request", message: "sessionId/text required" } });
      return;
    }
    const row = store.getSession(body.sessionId);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    const deliveryId = `dlv_${randomUUID()}`;
    deliveries.set(deliveryId, { hostId: row.host_id, sessionId: row.id, state: "queued", createdAt: Date.now() });
    const sent = sse.send(row.host_id, "deliver", {
      deliveryId,
      agentId: row.agent_id,
      nativeSessionId: row.native_id,
      hubSessionId: row.id,
      message: body.text,
      policy: typeof body.policy === "string" ? body.policy : "idle-only",
      createdAt: Date.now(),
    });
    res.json({ deliveryId, state: sent ? "dispatched" : "queued" });
  });

  app.get("/api/hub/deliveries/:id", (req, res) => {
    const delivery = deliveries.get(req.params.id);
    if (!delivery) {
      res.status(404).json({ error: { code: "not_found", message: "delivery not found" } });
      return;
    }
    res.json(delivery);
  });

  app.post("/api/hub/imports", (_req, res) => {
    res.status(501).json({ error: { code: "not_implemented", message: "import is not wired in the scaffold" } });
  });

  app.post("/api/hub/reload", (_req, res) => {
    res.json({ ok: true, note: "restart hub-service to apply config changes in the scaffold" });
  });

  const consoleDir = options.consoleDir;
  if (consoleDir) {
    app.get("/", (_req, res) => res.redirect("/hub/"));
    app.use("/hub/assets", express.static(join(consoleDir, "assets")));
    app.get(["/hub", "/hub/"], (_req, res) => res.sendFile(join(consoleDir, "index.html")));
    app.get(/.*/, (_req, res) => res.sendFile(join(consoleDir, "index.html")));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } });
  });

  return app;
}

function cookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
