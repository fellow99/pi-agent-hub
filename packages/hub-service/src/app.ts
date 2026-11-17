import express, { type NextFunction, type Request, type Response } from "express";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { FS_REQUEST_EVENT, MODEL_INFO_REQUEST_EVENT } from "@pi-agent-hub/protocol";
import {
  type CanonicalEntry,
  type CreateFsRequest,
  type DaemonTokenConfig,
  type DeliverImageUrl,
  type FsRequestEvent,
  type HubConfig,
  type ManifestRequest,
  type ManifestResponse,
  type ManifestSessionResult,
  type ModelInfoRequestEvent,
  type SessionTreeProjectNode,
  type SessionTreeResponse,
  type SessionTreeSessionNode,
  type SyncRequest,
  type UserRole,
} from "@pi-agent-hub/protocol";
import { Store, type SessionRow } from "./db.js";
import { SessionStore } from "./session-store.js";
import { projectKey } from "./file-tree.js";
import { SseHub } from "./sse.js";
import { FsRequestStore } from "./fs-request-store.js";
import { collectHostCwds, isAllowedByCwds } from "./fs-paths.js";
import { parseFsResultPayload } from "./fs-payload.js";
import { ModelInfoStore } from "./model-info-store.js";
import { sanitizeModelInfoResult } from "./model-info-allow.js";
import { Deliveries } from "./deliveries.js";
import { ImageStore, ImageValidationError } from "./image-store.js";
import { createSession, deleteSession, getCsrfToken, getSession, hashToken, tokenMatches, verifyUser, type ConsoleUser } from "./auth.js";

/** 简易 LRU：会话派生数据（文件树/子 agent）按 sessionId+updatedAt 缓存，容量 100（FR-202 NFR）。 */
class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly capacity: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

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
  const fileTreeCache = new LruCache<Awaited<ReturnType<SessionStore["scanFileTree"]>>>(100);
  const subagentCache = new LruCache<Awaited<ReturnType<SessionStore["listSubagents"]>>>(100);
  // 007：交付持久化（DB 态机）＋图片中转；006：模型信息纯内存态机。
  const deliveries = new Deliveries(store.db, sse);
  const imageStore = new ImageStore(options.dataDir);
  const fsRequests = new FsRequestStore();
  const modelInfos = new ModelInfoStore();
  const hostByToken = new Map<string, DaemonTokenConfig>();
  for (const token of options.config.daemonTokens) {
    hostByToken.set(token.tokenHash ?? hashToken(token.token ?? ""), token);
  }

  // 007：图片内联上传 body 上限提升（10×10MB base64 ≈ 133MB）；另有总/张数二次校验兜底。
  app.use(express.json({ limit: "160mb" }));

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
      capabilities: { sse: true, uploads: true, compression: "gzip" },
      limits: { manifestSessionsPerRequest: 5000, syncEntriesPerRequest: 5000, maxInlineBytes: 128 * 1024 * 1024, maxUploadBytes: 128 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024, maxSessionBytes: 128 * 1024 * 1024 },
    });
  });

  app.post("/api/v1/uploads", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const body = req.body as { kind?: string; hubSessionId?: string; mode?: string; since?: number; encoding?: string };
    if (typeof body.kind !== "string" || typeof body.hubSessionId !== "string" || (body.mode !== "full" && body.mode !== "delta")) {
      res.status(400).json({ error: { code: "invalid_request", message: "kind/hubSessionId/mode required" } });
      return;
    }
    const upload = sessions.createUpload({
      hubSessionId: body.hubSessionId,
      kind: body.kind,
      mode: body.mode,
      since: typeof body.since === "number" ? body.since : undefined,
      encoding: body.encoding === "ndjson+gzip" ? "ndjson+gzip" : "ndjson+gzip",
    });
    res.status(201).json({ uploadId: upload.uploadId, putUrl: `/api/v1/uploads/${upload.uploadId}`, expiresAt: upload.expiresAt, maxBytes: upload.maxBytes });
  });

  app.put("/api/v1/uploads/:uploadId", async (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const upload = sessions.getUpload(req.params.uploadId);
    if (!upload) { res.status(404).json({ error: { code: "not_found", message: "upload not found" } }); return; }
    if (upload.state === "committed" || upload.state === "failed") { res.status(409).json({ error: { code: "upload_closed", message: "upload already closed" } }); return; }
    const expectedDigest = req.get("digest");
    const digest = createHash("sha256");
    const gunzip = createGunzip();
    await mkdir(dirname(upload.tmpPath), { recursive: true });
    const out = createWriteStream(upload.tmpPath);
    try {
      const { bytes, sha } = await new Promise<{ bytes: number; sha: string }>((resolve, reject) => {
        let bytes = 0;
        req.on("data", (chunk) => {
          bytes += chunk.length;
          digest.update(chunk);
          if (bytes > upload.maxBytes) { req.destroy(); reject(new Error("upload_too_large")); }
        });
        req.on("error", reject);
        gunzip.on("error", reject);
        out.on("error", reject);
        out.on("finish", () => resolve({ bytes, sha: digest.digest("base64") }));
        req.pipe(gunzip).pipe(out);
      });
      if (expectedDigest && expectedDigest.trim() !== `sha-256=${sha}`) {
        await sessions.removeUpload(upload.uploadId);
        res.status(400).json({ error: { code: "bad_digest", message: "digest mismatch" } });
        return;
      }
      sessions.setUploadReady(upload.uploadId, bytes);
      res.json({ ok: true, bytes });
    } catch (error) {
      await sessions.removeUpload(upload.uploadId);
      const message = error instanceof Error ? error.message : String(error);
      if (message === "upload_too_large") { res.status(413).json({ error: { code: "upload_too_large", message: "exceeds maxBytes" } }); return; }
      res.status(422).json({ error: { code: "invalid_entry", message } });
    }
  });

  app.post("/api/v1/sync/manifest", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) {
      res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } });
      return;
    }
    const body = req.body as ManifestRequest;
    const results: ManifestSessionResult[] = [];
    const now = Date.now();
    for (const agent of body.agents ?? []) {
      store.upsertAgent({
        host_id: daemon.name,
        agent_id: agent.agentId,
        kind: agent.kind,
        version: agent.version ?? null,
        display_name: agent.displayName ?? null,
        home_dir: agent.homeDir ?? null,
        capabilities: agent.capabilities === undefined ? null : JSON.stringify(agent.capabilities),
        status: "online",
        last_seen_at: now,
      });
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
    let uploadedId: string | undefined;
    try {
      const body = req.body as SyncRequest & { entriesRef?: { uploadId: string } };
      if (body.entriesRef?.uploadId) {
        const upload = sessions.getUpload(body.entriesRef.uploadId);
        if (!upload) { res.status(422).json({ error: { code: "invalid_upload", message: "unknown upload" } }); return; }
        if (upload.state !== "ready") { res.status(422).json({ error: { code: "upload_not_ready", message: "upload not ready" } }); return; }
        const text = await readFile(upload.tmpPath, "utf8").catch(() => null);
        if (text === null) { res.status(422).json({ error: { code: "upload_not_ready", message: "upload data missing" } }); return; }
        const entries: CanonicalEntry[] = [];
        for (const line of text.split("\n")) {
          const clean = line.trim();
          if (!clean) continue;
          entries.push(JSON.parse(clean) as CanonicalEntry);
        }
        body.entries = entries;
        body.mode = body.mode ?? upload.mode;
        body.since = body.since ?? upload.since;
        uploadedId = upload.uploadId;
      }
      if (body.mode === "delta" && typeof body.since === "number") {
        const before = (body.entries ?? []).filter((entry) => Date.parse(entry.timestamp) < body.since!);
        if (before.length > 0) {
          res.status(422).json({ error: { code: "entry_before_since", message: "entry timestamp before since" } });
          return;
        }
      }
      const result = await sessions.sync(row, body);
      if (uploadedId) await sessions.removeUpload(uploadedId);
      res.json({ hubSessionId: id, ...result, status: "ok" });
    } catch (error) {
      if (uploadedId) await sessions.removeUpload(uploadedId);
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
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const outcome = deliveries.ack(req.params.id, daemon.name);
    if (outcome === "not_found" || outcome === "host_mismatch") {
      res.status(404).json({ error: { code: "not_found", message: "delivery not found" } });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/v1/deliveries/:id/result", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const body = req.body as { ok?: unknown; result?: { state?: string; nativeMessageId?: string; warnings?: string[] }; error?: { code?: string; message?: string } };
    const outcome = deliveries.result(req.params.id, daemon.name, {
      ok: body.ok === true,
      result: typeof body.result === "object" && body.result !== null ? {
        state: body.result.state ?? "completed",
        nativeMessageId: body.result.nativeMessageId,
        warnings: body.result.warnings,
      } : undefined,
      error: body.error ? {
        code: typeof body.error.code === "string" ? body.error.code : "agent_error",
        message: typeof body.error.message === "string" ? body.error.message : "delivery failed",
      } : undefined,
    });
    if (outcome === "not_found" || outcome === "host_mismatch") {
      res.status(404).json({ error: { code: "not_found", message: "delivery not found" } });
      return;
    }
    res.json({ ok: true });
  });

  // 007：断线/pending 补齐（与 SSE 事件同构）。
  app.get("/api/v1/deliveries", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const pending = deliveries.listPending(daemon.name);
    res.json({
      items: pending.map((row) => ({
        deliveryId: row.id,
        agentId: row.agent_id,
        nativeSessionId: row.native_session_id,
        hubSessionId: row.session_id,
        message: row.text ?? "",
        images: row.images_json ? JSON.parse(row.images_json) as DeliverImageUrl[] : [],
        model: row.model_provider && row.model_id ? { provider: row.model_provider, modelId: row.model_id } : null,
        thinkingLevel: row.thinking_level,
        policy: row.policy ?? "idle-only",
        force: row.force === 1,
        attempt: row.attempts,
        createdAt: row.created_at,
        expiresAt: row.created_at + 10 * 60_000,
      })),
      nextCursor: null,
    });
  });

  // 007：daemon 下载交付图片（Bearer + host 归属 + Range 支持）。
  app.get("/api/v1/deliveries/:deliveryId/images/:index", async (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const row = deliveries.getRow(req.params.deliveryId);
    if (!row || row.host_id !== daemon.name) {
      res.status(404).json({ error: { code: "not_found", message: "delivery not found" } });
      return;
    }
    const index = Number(req.params.index);
    const images: DeliverImageUrl[] = row.images_json ? JSON.parse(row.images_json) as DeliverImageUrl[] : [];
    const image = images[index];
    if (!image || image.url !== `/api/v1/deliveries/${encodeURIComponent(row.id)}/images/${index}`) {
      res.status(404).json({ error: { code: "not_found", message: "image not found" } });
      return;
    }
    const mime = image.mime;
    const buffer = await imageStore.readImage(row.id, index);
    if (!buffer) {
      res.status(410).json({ error: { code: "image_expired", message: "delivery image has been garbage collected" } });
      return;
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  });

  app.post("/api/v1/imports/:id/result", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/v1/exports/:id/result", (_req, res) => {
    res.json({ ok: true });
  });

  // 005 FS Bridge：daemon ack/result 回传（Bearer；校验 token 绑定 host 与请求归属一致）。
  app.post("/api/v1/fs-requests/:requestId/ack", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const outcome = fsRequests.ack(req.params.requestId, daemon.name);
    if (outcome === "not_found" || outcome === "host_mismatch") {
      // 不向陌生 host 泄露 id 是否存在，统一 404。
      res.status(404).json({ error: { code: "not_found", message: "fs request not found" } });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/v1/fs-requests/:requestId/result", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const payload = parseFsResultPayload(req.body);
    if (!payload) {
      res.status(400).json({ error: { code: "invalid_request", message: "ok with result|error required" } });
      return;
    }
    const outcome = fsRequests.result(req.params.requestId, daemon.name, payload);
    if (outcome === "not_found" || outcome === "host_mismatch") {
      res.status(404).json({ error: { code: "not_found", message: "fs request not found" } });
      return;
    }
    res.json({ ok: true });
  });

  // 006 Model Info：daemon ack/result 回传（Bearer + host 归属；result 先经白名单脱敏）。
  app.post("/api/v1/model-info-requests/:requestId/ack", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const outcome = modelInfos.ack(req.params.requestId, daemon.name);
    if (outcome === "not_found" || outcome === "host_mismatch") {
      res.status(404).json({ error: { code: "not_found", message: "model info request not found" } });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/v1/model-info-requests/:requestId/result", (req, res) => {
    const daemon = (req as AuthedRequest).daemon;
    if (!daemon) { res.status(401).json({ error: { code: "token_unknown", message: "unknown token" } }); return; }
    const body = req.body as { ok?: unknown; result?: unknown; error?: unknown };
    if (body.ok === true) {
      // 兜底脱敏：结构/白名单失败 → 置 invalid_result，不落 completed。
      const sanitized = sanitizeModelInfoResult(body.result);
      const outcome = modelInfos.result(req.params.requestId, daemon.name, sanitized);
      if (outcome === "not_found" || outcome === "host_mismatch") {
        res.status(404).json({ error: { code: "not_found", message: "model info request not found" } });
        return;
      }
      res.json({ ok: true });
      return;
    }
    const err = isPlainObject(body.error)
      ? { code: toModelInfoErrorCode(body.error.code),
          message: typeof body.error.message === "string" ? body.error.message : "model info failed" }
      : { code: "agent_error" as const, message: "model info failed" };
    const outcome = modelInfos.result(req.params.requestId, daemon.name, { ok: false, error: err });
    if (outcome === "not_found" || outcome === "host_mismatch") {
      res.status(404).json({ error: { code: "not_found", message: "model info request not found" } });
      return;
    }
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

  app.get("/api/hub/agents", (req, res) => {
    const host = req.query.host ? String(req.query.host) : undefined;
    const items = store.listAgents(host).map((row) => ({
      id: row.agent_id,
      hostId: row.host_id,
      kind: row.kind,
      version: row.version,
      displayName: row.display_name,
      homeDir: row.home_dir,
      capabilities: safeJson(row.capabilities),
      status: row.status,
      lastSeenAt: row.last_seen_at,
    }));
    res.json({ items, nextCursor: null });
  });

  app.get("/api/hub/sessions", (_req, res) => {
    res.json({ items: store.listSessions().map((row) => sessions.summary(row)), nextCursor: null });
  });

  // 202：三级会话树（项目 cwd → host|agent → 会话），支持 q 关键字过滤（FR-202-005~007）。
  app.get("/api/hub/session-tree", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLocaleLowerCase() : "";
    const kindByAgent = new Map(store.listAgents().map((agent) => [`${agent.host_id}\0${agent.agent_id}`, agent.kind]));
    const rows = store.listSessions().filter((row) => {
      if (!q) return true;
      return row.cwd.toLocaleLowerCase().includes(q)
        || (row.title ?? "").toLocaleLowerCase().includes(q)
        || row.agent_id.toLocaleLowerCase().includes(q)
        || row.host_id.toLocaleLowerCase().includes(q);
    });
    const projects = new Map<string, { label: string; lastUpdated: number; agents: Map<string, SessionTreeSessionNode> }>();
    for (const row of rows) {
      const key = projectKey(row.cwd);
      let project = projects.get(key);
      if (!project) {
        project = { label: row.cwd, lastUpdated: row.updated_at, agents: new Map() };
        projects.set(key, project);
      }
      project.lastUpdated = Math.max(project.lastUpdated, row.updated_at);
      const agentKey = `${row.host_id}|${row.agent_id}`;
      let agentNode = project.agents.get(agentKey);
      if (!agentNode) {
        agentNode = {
          key: agentKey, hostId: row.host_id, agentId: row.agent_id,
          kind: kindByAgent.get(`${row.host_id}\0${row.agent_id}`) ?? null,
          sessionCount: 0, sessions: [],
        };
        project.agents.set(agentKey, agentNode);
      }
      agentNode.sessionCount += 1;
      agentNode.sessions.push(sessions.summary(row));
    }
    const payload: SessionTreeResponse = {
      projects: [...projects.entries()]
        .map(([key, project]): SessionTreeProjectNode => ({
          key,
          label: project.label,
          sessionCount: [...project.agents.values()].reduce((sum, agent) => sum + agent.sessionCount, 0),
          agents: [...project.agents.values()]
            .sort((a, b) => a.hostId.localeCompare(b.hostId) || a.agentId.localeCompare(b.agentId)),
        }))
        .sort((a, b) => {
          const aTime = Math.max(...a.agents.flatMap((agent) => agent.sessions.map((session) => session.updatedAt)));
          const bTime = Math.max(...b.agents.flatMap((agent) => agent.sessions.map((session) => session.updatedAt)));
          return bTime - aTime;
        }),
    };
    res.json(payload);
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
    const result = await sessions.transcript(req.params.id, tail, before);
    if (result.unavailable) {
      // 会话镜像文件缺失：返回 404 而非 500（内容不可用，可能是会话目录被清理/未重同步）
      res.status(404).json({ error: { code: "content_unavailable", message: "session content not available (mirror file missing)" } });
      return;
    }
    res.json(result);
  });

  app.get("/api/hub/sessions/:id/blocks/:seq/raw", async (req, res) => {
    const entry = await sessions.readEntry(req.params.id, Number(req.params.seq));
    if (!entry) {
      res.status(404).end();
      return;
    }
    res.type("text/plain").send(JSON.stringify(entry, null, 2));
  });

  // 202：会话推导的虚拟文件树（FR-202-008~010）。
  app.get("/api/hub/sessions/:id/files", async (req, res) => {
    const row = store.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    const cacheKey = `${req.params.id}:${row.updated_at}`;
    let result = fileTreeCache.get(cacheKey);
    if (!result) {
      result = await sessions.scanFileTree(req.params.id);
      fileTreeCache.set(cacheKey, result);
    }
    if (result === null) {
      res.status(404).json({ error: { code: "content_unavailable", message: "session content not available (mirror file missing)" } });
      return;
    }
    const { scan: _scan, ...payload } = result;
    res.json(payload);
  });

  // 202：虚拟文件内容（FR-202-011/012）。
  app.get("/api/hub/sessions/:id/files/content", async (req, res) => {
    const row = store.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) {
      res.status(400).json({ error: { code: "invalid_request", message: "path required" } });
      return;
    }
    const treeKey = `${req.params.id}:${row.updated_at}`;
    let tree = fileTreeCache.get(treeKey);
    if (!tree) {
      tree = await sessions.scanFileTree(req.params.id);
      fileTreeCache.set(treeKey, tree);
    }
    if (tree === null) {
      res.status(404).json({ error: { code: "content_unavailable", message: "session content not available (mirror file missing)" } });
      return;
    }
    const rel = tree.scan.fileIndex.has(path) ? path : [...tree.scan.fileIndex.keys()].find((key) => key.toLocaleLowerCase() === path.toLocaleLowerCase());
    if (!rel) {
      res.status(404).json({ error: { code: "file_not_tracked", message: "file path not seen in session activity" } });
      return;
    }
    const content = await sessions.readFileContent(req.params.id, rel);
    if (content === null) {
      res.status(404).json({ error: { code: "content_unavailable", message: "session content not available (mirror file missing)" } });
      return;
    }
    res.json(content);
  });

  // 202：子 agent 调用列表（FR-202-013/015）。
  app.get("/api/hub/sessions/:id/subagents", async (req, res) => {
    const row = store.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    const cacheKey = `${req.params.id}:${row.updated_at}`;
    let items = subagentCache.get(cacheKey);
    if (!items) {
      items = await sessions.listSubagents(req.params.id);
      subagentCache.set(cacheKey, items);
    }
    if (items === null) {
      res.status(404).json({ error: { code: "content_unavailable", message: "session content not available (mirror file missing)" } });
      return;
    }
    res.json({ items });
  });

  // 202：单次子 agent 调用的 transcript（FR-202-014/016）。
  app.get("/api/hub/sessions/:id/subagents/:subagentId/transcript", async (req, res) => {
    if (!store.getSession(req.params.id)) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    const result = await sessions.subagentTranscript(req.params.id, req.params.subagentId);
    if (result === null) {
      res.status(404).json({ error: { code: "content_unavailable", message: "session content not available (mirror file missing)" } });
      return;
    }
    if ("notFound" in result) {
      res.status(404).json({ error: { code: "subagent_not_found", message: "subagent invocation not found" } });
      return;
    }
    res.json(result);
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

  // 007：发起下发（admin+CSRF 由 /api/hub 中间件保证）。支持文本/图片/model/thinkingLevel/policy/idempotencyKey。
  app.post("/api/hub/deliveries", async (req, res, next) => {
    try {
      const body = req.body as {
        sessionId?: unknown; text?: unknown; images?: unknown; model?: unknown; thinkingLevel?: unknown;
        policy?: unknown; force?: unknown; idempotencyKey?: unknown;
      };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        res.status(400).json({ error: { code: "invalid_request", message: "sessionId required" } });
        return;
      }
      const text = typeof body.text === "string" ? body.text : "";
      const images = Array.isArray(body.images)
        ? body.images.filter(isDeliverImageInput)
        : [];
      if (body.images !== undefined && !Array.isArray(body.images)) {
        res.status(400).json({ error: { code: "invalid_request", message: "images must be an array" } });
        return;
      }
      if (images.length && images.length !== (body.images as unknown[]).length) {
        res.status(400).json({ error: { code: "invalid_request", message: "images entry malformed" } });
        return;
      }
      if (!text.trim() && images.length === 0) {
        res.status(400).json({ error: { code: "invalid_request", message: "text or images required" } });
        return;
      }
      if (body.thinkingLevel !== undefined && body.thinkingLevel !== null
        && (typeof body.thinkingLevel !== "string" || body.thinkingLevel.length === 0)) {
        res.status(400).json({ error: { code: "invalid_request", message: "thinkingLevel must be a non-empty string or null" } });
        return;
      }
      let model: { provider: string; modelId: string } | null = null;
      if (body.model !== undefined && body.model !== null) {
        if (!isPlainObject(body.model) || typeof body.model.provider !== "string" || typeof body.model.modelId !== "string") {
          res.status(400).json({ error: { code: "invalid_request", message: "model must be {provider, modelId}" } });
          return;
        }
        model = { provider: body.model.provider, modelId: body.model.modelId };
      }
      const policy = body.policy === "force" || body.policy === "idle-only" ? body.policy : "idle-only";
      if (body.policy !== undefined && body.policy !== "idle-only" && body.policy !== "force") {
        res.status(400).json({ error: { code: "invalid_request", message: "policy must be idle-only or force" } });
        return;
      }
      const force = body.force === true || policy === "force";
      const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0
        ? body.idempotencyKey.slice(0, 128)
        : undefined;

      const row = store.getSession(body.sessionId);
      if (!row) {
        res.status(404).json({ error: { code: "session_not_found", message: "session not found" } });
        return;
      }
      if (!row.host_id || !row.agent_id || !row.native_id) {
        res.status(422).json({ error: { code: "session_incomplete", message: "session missing host/agent/native ids" } });
        return;
      }
      if (!options.config.daemonTokens.some((token) => token.name === row.host_id)) {
        res.status(404).json({ error: { code: "host_unknown", message: "unknown host" } });
        return;
      }

      if (idempotencyKey) {
        const existing = deliveries.findByKey(idempotencyKey);
        if (existing) {
          res.json(deliveries.getView(existing.id));
          return;
        }
      }

      const deliveryId = `dlv_${randomUUID()}`;
      let imageUrls: DeliverImageUrl[] = [];
      try {
        imageUrls = await imageStore.saveImages(deliveryId, images);
      } catch (error) {
        if (error instanceof ImageValidationError) {
          res.status(400).json({ error: { code: error.code, message: error.message } });
          return;
        }
        throw error;
      }
      const view = await deliveries.create({
        deliveryId,
        hostId: row.host_id,
        agentId: row.agent_id,
        sessionId: row.id,
        nativeSessionId: row.native_id,
        text,
        images: imageUrls,
        model,
        thinkingLevel: body.thinkingLevel === undefined || body.thinkingLevel === null ? null : body.thinkingLevel,
        policy,
        force,
        idempotencyKey,
      });
      res.status(202).json({ deliveryId, state: view.state });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/hub/deliveries/:id", (req, res) => {
    const view = deliveries.getView(req.params.id);
    if (!view) {
      res.status(404).json({ error: { code: "not_found", message: "delivery not found" } });
      return;
    }
    res.json(view);
  });

  app.post("/api/hub/deliveries/:id/cancel", (req, res) => {
    const outcome = deliveries.cancel(req.params.id);
    if (outcome === "not_found") {
      res.status(404).json({ error: { code: "not_found", message: "delivery not found" } });
      return;
    }
    res.json({ ok: true });
  });

  // 006：console 发起模型信息请求（admin+CSRF；按 session 粒度，hub 解析 host/agent/native）。
  app.post("/api/hub/model-info-requests", (req, res) => {
    const body = req.body as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
      res.status(400).json({ error: { code: "invalid_request", message: "sessionId required" } });
      return;
    }
    const row = store.getSession(body.sessionId);
    if (!row) {
      res.status(404).json({ error: { code: "session_not_found", message: "session not found" } });
      return;
    }
    if (!row.host_id || !row.agent_id || !row.native_id) {
      res.status(422).json({ error: { code: "session_incomplete", message: "session missing host/agent/native ids" } });
      return;
    }
    if (!options.config.daemonTokens.some((token) => token.name === row.host_id)) {
      res.status(404).json({ error: { code: "host_unknown", message: "unknown host" } });
      return;
    }
    const requestId = `mri_${randomUUID()}`;
    const event: ModelInfoRequestEvent = {
      requestId,
      agentId: row.agent_id,
      nativeSessionId: row.native_id,
    };
    const sent = sse.send(row.host_id, MODEL_INFO_REQUEST_EVENT, event);
    if (!sent) {
      res.status(503).json({ error: { code: "host_offline", message: "host has no active event connection" } });
      return;
    }
    const record = modelInfos.createWithId(requestId, {
      hostId: row.host_id,
      agentId: row.agent_id,
      sessionId: row.id,
    });
    res.status(202).json({ requestId: record.requestId, state: record.state });
  });

  // 006：console 轮询（GET 不限角色）。
  app.get("/api/hub/model-info-requests/:requestId", (req, res) => {
    const record = modelInfos.get(req.params.requestId);
    if (!record) {
      res.status(404).json({ error: { code: "not_found", message: "model info request not found" } });
      return;
    }
    res.json(record);
  });

  // 005 FS Bridge：console 发起 FS 请求（admin+CSRF 由 /api/hub 中间件保证）。
  app.post("/api/hub/fs-requests", (req, res) => {
    const body = req.body as Partial<CreateFsRequest>;
    if (
      typeof body.hostId !== "string" || body.hostId.length === 0
      || (body.kind !== "list_dir" && body.kind !== "read_file")
      || typeof body.path !== "string" || body.path.length === 0
    ) {
      res.status(400).json({ error: { code: "invalid_request", message: "hostId/kind/path required" } });
      return;
    }
    if (body.path.includes("\0")) {
      res.status(400).json({ error: { code: "invalid_request", message: "invalid path" } });
      return;
    }
    const hostConfig = options.config.daemonTokens.find((token) => token.name === body.hostId);
    if (!hostConfig) {
      res.status(404).json({ error: { code: "host_unknown", message: "unknown host" } });
      return;
    }
    // 第一道白名单：path 必须落在该 host 已知会话 cwd 集合之内。
    const cwds = collectHostCwds(store.listSessions(), body.hostId);
    if (!isAllowedByCwds(body.path, cwds)) {
      res.status(403).json({ error: { code: "path_not_allowed", message: "path is outside known session cwds" } });
      return;
    }
    const requestId = `fsr_${randomUUID()}`;
    const event: FsRequestEvent = { requestId, kind: body.kind, path: body.path };
    // 先确认 SSE 在线再建记录：send 失败直接 503，不留悬空记录。
    // 顺序依赖 Node 单线程事件循环：send 与 createWithId 之间无 await，daemon 不可能在二者之间插入回写。
    const sent = sse.send(body.hostId, FS_REQUEST_EVENT, event);
    if (!sent) {
      res.status(503).json({ error: { code: "host_offline", message: "host has no active event connection" } });
      return;
    }
    const record = fsRequests.createWithId(requestId, { hostId: body.hostId, kind: body.kind, path: body.path });
    res.status(202).json({ requestId: record.requestId, state: record.state });
  });

  // 005 FS Bridge：console 轮询（GET 不限制角色；failed/expired 也用 200，错误在体内）。
  app.get("/api/hub/fs-requests/:requestId", (req, res) => {
    const record = fsRequests.get(req.params.requestId);
    if (!record) {
      res.status(404).json({ error: { code: "not_found", message: "fs request not found" } });
      return;
    }
    res.json(record);
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

function safeJson(value: string | null): unknown {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 006：daemon 回传错误码白名单——未知 code 一律归 agent_error，保持稳定枚举。 */
function toModelInfoErrorCode(value: unknown): import("@pi-agent-hub/protocol").ModelInfoErrorCode {
  if (typeof value === "string"
    && (value === "forbidden_role" || value === "csrf_failed" || value === "invalid_request"
      || value === "session_not_found" || value === "session_incomplete" || value === "host_unknown"
      || value === "host_offline" || value === "not_found" || value === "expired"
      || value === "agent_unsupported" || value === "agent_error" || value === "invalid_result"
      || value === "host_mismatch")) {
    return value;
  }
  return "agent_error";
}

function isDeliverImageInput(value: unknown): value is { mime: string; dataBase64: string; name?: string } {
  return isPlainObject(value)
    && typeof value.mime === "string"
    && typeof value.dataBase64 === "string";
}


