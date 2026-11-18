# 004-sync-session Technical Plan（实现方案）

> Module: 004-sync-session
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM（≥22.19）；hub=Express 5 + node:sqlite；daemon/插件=纯 Node 子进程 JSON-RPC over stdio。
- 既有代码（scaffold 已实现，本需求复用）：
  - `packages/sync-plugin-pi-agent/src/plugin.ts`：listSessions/readSession（full/delta/大包）。
  - `packages/sync-daemon/src/{daemon,hub-client,plugin-manager}.ts`：manifest→diff→sync、SSE、插件管理。
  - `packages/hub-service/src/{app,session-store,db}.ts`：同步/查询接口、合并、索引。
  - `packages/hub-console/src/`：Sessions、SessionDetail、Hosts 页，`api.ts` 客户端。

## 2. Constitution 符合性
- ✅ 插件子进程边界：daemon 经 JSON-RPC 调插件，插件不直连 hub。
- ✅ 统一 pi v3 canonical 契约：采集→归一→合并全链路复用 `pi-session`。
- ✅ API 前缀与幂等纪律：`/api/v1`、`/api/hub`；entryId 去重。
- ✅ 只读浏览：查询接口 GET only，viewer 写操作 403。
- ✅ 严格类型：无 any / ts-ignore；改动后 `pnpm typecheck` 全绿。

## 3. 研究结论
- **同步链路已闭环**：`syncAll` → `list_sessions`（插件）→ `hub.manifest`（水位）→
  `syncOne`（`read_session` 差分/全量 → `hub.sync`），与会话同步设计（docs/001 §4 附录 A）一致。
- **缺口定位**：
  1. `hub-service/src/app.ts` 中 `GET /api/hub/agents` 恒返回 `{items:[]}`，且 manifest 未登记 agent。
  2. `hub-console` 无 Agents 页面与导航入口。
  3. 未做过真实 `~/.pi` 数据的端到端联调验证。
- **agent 登记设计**：manifest 请求 `agents[]` 已含 agentId/kind/capabilities，但无 version/homeDir 字段直达。
  需要：daemon 在 manifest 的 agent 上补充 `version`（插件 initialize 返回的 pluginVersion / metadata）；
  hub 侧新增 `agents` 表（或在内存 Map）登记 (hostId,agentId)→{kind,version,capabilities,homeDir,lastSeenAt}。

## 4. 实现方案

### 4.1 hub-service：agent 登记与查询
- `db.ts`：新增 `agents` 表
  ```sql
  CREATE TABLE IF NOT EXISTS agents (
    host_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL, version TEXT, display_name TEXT,
    home_dir TEXT, capabilities TEXT DEFAULT '{}',
    status TEXT DEFAULT 'online', last_seen_at INTEGER,
    PRIMARY KEY (host_id, agent_id)
  );
  ```
- `db.ts`：新增 `upsertAgent` / `listAgents(hostId?)` / `getAgent`。
- `app.ts`：
  - manifest 处理中，对每个 agent 调 `store.upsertAgent`（kind/version/capabilities/lastSeenAt），幂等。
  - `GET /api/hub/agents` 返回 `store.listAgents()` 组装 `{id:agentId, hostId, kind, version, displayName, homeDir, capabilities, status, lastSeenAt}`。
- **daemon 侧 version 补充**：manifest 的 `ManifestAgent` 增加 `version`；`daemon.ts` 填 `runtime.plugin.metadata` 版本。
  - 检查 protocol 类型 `ManifestAgent` 是否含 version 字段；若无则扩展（protocol 是内部契约，可加可选字段，向后兼容）。

### 4.2 hub-console：Agents 页面
- `api.ts`：新增 `listAgents()`（GET `/api/hub/agents`）。
- `views/Agents.vue`：表格展示 host / kind / agentId / displayName / version / capabilities 位 /
  homeDir / 状态 / 最后在线；空态提示。
- `router.ts`：注册 `/agents`；`App.vue` 导航加 `Agents` 项。

### 4.3 端到端联调验证
- 本机起 hub-service（`HUB_CONFIG_FILE=./examples/hub-service.json pnpm dev:hub`，127.0.0.1:8443）。
- 本机起 sync-daemon `--once`（`--config ./examples/sync-daemon.json`，插件指向本地包），采集真实 `~/.pi` 会话。
- curl 校验：manifest/同步水位、`/api/hub/sessions`、`/api/hub/agents`、某会话 `/transcript`。
- console 页面浏览（登录 admin）抽查 Agent/Sessions/Detail。

### 4.4 补充（视联调结果）
- 若真实数据联调发现合并/标题/水位偏差，记录并在测试阶段修（最小改动）。

## 5. 文件清单
| 文件 | 改动 |
|---|---|
| `packages/protocol/src/index.ts` | ManifestAgent 增加可选 version 字段（如缺） |
| `packages/sync-daemon/src/daemon.ts` | manifest agent 报文补充 version |
| `packages/hub-service/src/db.ts` | 新增 agents 表 + upsertAgent/listAgents |
| `packages/hub-service/src/app.ts` | manifest 登记 agent；/api/hub/agents 实现 |
| `packages/hub-console/src/api.ts` | listAgents() |
| `packages/hub-console/src/views/Agents.vue` | 新增页面 |
| `packages/hub-console/src/router.ts` | /agents 路由 |
| `packages/hub-console/src/App.vue` | 导航入口 |
| `specs/004-sync-session/tasks.md` / `test-cases.md` | 任务清单 / 测试用例 |

## 6. 测试考虑
- 单测：沿用 `vitest --passWithNoTests`；本次重点做端到端手动验证（Docker 可跑 hub 镜像服务，本机 Node 跑 daemon/插件）。
- 覆盖：manifest→full→delta 幂等、agent 登记幂等、console 三页浏览、真实 ~/.pi 会话数据。

---

# 7. 附属文件落盘转存 — 技术方案（对应 spec §8）

> 设计文档：`docs/004-会话同步-附属文件.md`（方案 B）。本节为其工程落地映射，遇冲突以设计文档为准并在此记录偏差。

## 7.1 技术上下文（新增事实）
- 既有参照：`hub-service/src/image-store.ts`（007 交付图片，base64→校验→落盘→url，失败回滚），新类风格对齐。
- 同步写入口：`app.ts` `POST /api/v1/sync/sessions/:id` → `SessionStore.sync(row, request)`；`row.host_id/agent_id/row.id` 即落盘三段上下文，无需改路由签名。
- 读入口：`/api/hub` 中间件已实现 cookie 鉴权 + GET 免 CSRF（app.ts §114–135 区段）。
- 现状：`toTranscriptItem()` image 分支恒 `{kind:"image", mime, url:""}`；BlockCard 仅 el-tag 占位；dsh `toHubParts()` image 只传 mimeType。
- 无会话删除端点/流程（db 仅 `state != 'deleted'` 过滤）：本期提供 `cleanupSession()` 方法与调用位，不新建删除 API；孤儿 GC 工具标 ⬜。

## 7.2 协议（packages/protocol/src/index.ts）
- 新增常量（紧邻 `DELIVERY_IMAGE_LIMITS`）：
  ```ts
  export const SYNC_ATTACHMENT_LIMITS = {
    singleBytes: 10 * 1024 * 1024,
    maxCount: 10,
    totalBytes: 100 * 1024 * 1024,
    mimePrefixes: ["image/", "video/", "audio/"],
    mimeExact: ["application/pdf"],
  } as const;
  ```
- `TranscriptBlock` 增加 `| { kind: "attachment"; mime: string; url: string; name?: string }`（image 成员已存在，补注释）。
- 新增错误码联合成员 `SyncAttachmentErrorCode = "attachment_invalid" | "attachment_too_large" | "attachment_mime_denied"`，纳入 hub 422 响应 code 枚举（路由层映射，不向 daemon 泄露 500）。

## 7.3 hub-service：SyncAttachmentStore（新文件 src/sync-attachment-store.ts）
```ts
export interface SyncAttachmentInput { mime: string; dataBase64: string; name?: string }
export interface SyncAttachmentRef { mime: string; url: string; sha256: string; bytes: number; name?: string }

export class SyncAttachmentError extends Error {
  constructor(readonly code: SyncAttachmentErrorCode, message: string) { ... }
}

export class SyncAttachmentStore {
  constructor(private readonly dataDir: string) {}
  sessionDir(host, agent, sessionId): string  // dataDir/sync/<host>/<agent>/<hs>
  async save(host, agent, sessionId, parts: SyncAttachmentInput[]): Promise<SyncAttachmentRef[]>
  async read(host, agent, sessionId, hash): Promise<{ mime: string; buffer: Buffer } | null>
  async cleanupSession(host, agent, sessionId): Promise<void>
}
```
实现要点：
- 目录段（host/agent/sessionId）做 `\0` 与路径分隔符校验，拒绝非法段（防御纵深，row 来源可信但不隐式假设）。
- save：空数组直返；先全量解码+校验（数量按**单条 entry** 计数 ≤10、单批 totalBytes ≤100MB、mime 前缀/精确白名单、base64 非空），再统一落盘；记录本轮新建文件清单，catch 时仅 rm 新建项（已存在的去重文件不删）。
- 落盘：`mkdir -p` → 写 `tmp-<pid>-<rand>` → `rename` 到 `<dir>/<sha256hex>`；已存在跳过。
- url 统一由 store 生成：`/api/hub/sessions/${sessionId}/attachments/${sha256}`（sessionId 已含 `hs_`，encodeURIComponent 处理）。
- read：hash 正则 `^[0-9a-f]{64}$` 不匹配返回 null；mime 不由 store 持久化（无 manifest，D4），由调用方从镜像 block 注册表取得后传入响应。

## 7.4 hub-service：session-store.ts 接入
- 构造函数增参 `attachmentStore: SyncAttachmentStore`（app.ts 装配；既有测试实例化处同步改）。
- 新增模块级纯函数 `collectAttachmentParts(entries): Map<entry, part[]>` 与 `rewriteParts(...)`：
  1. 遍历 entries 的 `message.content[]`，识别 `type==="image"|"attachment"` 且含 `dataBase64` 或 `data` 的 part。
  2. 按 entry 维度组织输入（满足单消息 maxCount 语义），整批调 `save(row.host_id, row.agent_id, row.id, ...)`。
  3. 以返回 ref 的 sha256 回填：part 删 `dataBase64`/`data`，写 `url=ref.url`，image 保留 `mimeType`，attachment 保留 `name?`。
- 调用点：`sync()` 内 full/delta 分支**写文件之前**（entriesRef 解析之后、validateEntries 之前/之后均可；选 validate 之后避免坏数据触发落盘）。
- `toTranscriptItem()`：
  - image：`url = part.url ?? (内联 base64 → data:${mime};base64,…) ?? ""`；block 保持 `kind:"image"`。
  - attachment：同理产出 `kind:"attachment", mime, url, name?`（无 url 且无内联则不出 block，与现状占位策略一致——image 保留占位 tag，attachment 无占位契约则跳过）。
- 新增 `registeredAttachment(id, hash): { mime: string; url: string } | null`：读镜像 entries，扫描 image/attachment part 的 url，命中精确匹配返回 mime（注册表校验 + mime 来源，供路由复用；顺序扫描，量小可接受，规模大再建索引 ⬜）。

## 7.5 hub-service：app.ts 读取路由
- 装配 `const syncAttachments = new SyncAttachmentStore(options.dataDir)`，传入 SessionStore。
- 新路由（置于 `/api/hub/sessions/:id` 附近，受 /api/hub cookie 中间件保护）：
  `GET /api/hub/sessions/:id/attachments/:hash`
  1. hash 正则失败 → 400 `invalid_request`；2. row 不存在 → 404；3. `registeredAttachment` 未命中 → 404（不暴露存在性）；
  4. `syncAttachments.read(...)` → null 404；5. 响应头 Content-Type=注册 mime、Cache-Control immutable、ETag、nosniff，send(buffer)。
- 同步错误映射：`SyncAttachmentError` 在 sync 路由 catch 中映射为 422 + 其 code（其余异常维持 invalid_entry）。

## 7.6 hub-console
- `api.ts`：TranscriptBlock 联合补 attachment 成员（与 protocol 对齐）。
- `BlockCard.vue`：image 分支改 `<el-image v-if="block.url" :src :preview-src-list :fit>` + `@error` 占位；无 url 维持 el-tag。新增 attachment 分支：本期最小实现 `<el-link :href=url target=_blank download>{{ name || mime }}</el-link>`（video/audio 内联播放 ⬜）。

## 7.7 sync-plugin-dsh
- `toHubParts(blocks, attachmentRoot)` 改 async（或在 readSession 内联 await 解析）：image block 取 `block.attachment?.attachmentId`，去 `sha256:` 前缀得 64hex → 读 `~/.dsh/attachments/v1/objects/<h2>/<hash>` → `dataBase64=buffer.toString("base64")`，mime 取 `attachment.mediaType ?? block.mediaType ?? block.mimeType`，name 取 `attachment.name`。
- 附件根：默认 `expandHome("~/.dsh/attachments/v1/objects")`，允许 options.attachmentRoot 覆盖；读失败（ENOENT 等）降级 `{type:"image", mimeType}` 占位，catch 不抛（不阻断同步）。

## 7.8 文件清单
| 文件 | 改动 |
|---|---|
| `packages/protocol/src/index.ts` | SYNC_ATTACHMENT_LIMITS、错误码、TranscriptBlock attachment 成员 |
| `packages/hub-service/src/sync-attachment-store.ts` | 新增：save/read/cleanupSession + SyncAttachmentError |
| `packages/hub-service/src/session-store.ts` | sync() 落盘接入+part 改写；toTranscriptItem 三级出图；registeredAttachment |
| `packages/hub-service/src/app.ts` | 装配 store；GET attachments 路由；错误码映射 |
| `packages/hub-service/src/__tests__/sync-attachment-store.test.ts` | 新增单测（落盘/去重/回滚/白名单/hash 校验） |
| `packages/hub-console/src/api.ts` | TranscriptBlock 联合 |
| `packages/hub-console/src/components/BlockCard.vue` | el-image + 失败兜底 + attachment 最小分支 |
| `packages/sync-plugin-dsh/src/plugin.ts` | 附件对象读取 → dataBase64 + 降级 |

## 7.9 偏差与待验证
- 设计文档 §3.3 `read()` 签名只返回 buffer；本方案 mime 改由镜像注册表提供（store 不持久化元数据，符合 D4「无 manifest」），属实现细化而非语义偏差。
- ⬜ daemon 侧「超限降级为纯文本重试」（设计 §3.3/§8）不在本期：本期整批 422，待后续迭代。
- ⬜ `gcSyncAttachments` 孤儿清理手工命令、会话删除联动（当前无删除 API）：仅交付 cleanupSession 能力位。
- 待真机验证：dsh 三会话附件覆盖率；100MB 单批与首屏性能；nginx `client_max_body_size 16m` 对内联大图的约束（现状 160mb express limit 在前，反代 16m 在前，超限走 entriesRef upload 流 ⬜ 实测）。
