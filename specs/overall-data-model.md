# overall-data-model.md — 数据模型

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：依据真实源码（`packages/hub-service/src/db.ts`、`protocol/src/index.ts`、`pi-session/src/index.ts`）整理。

---

## 1. 核心实体与关系

```text
DaemonTokenConfig (配置) 1 ── n  Session (hub.db)
HubUserConfig (配置)     1 ── n  (角色授权)
Session                 1 ── n  CanonicalEntry (JSONL 内)
Delivery (hub.db)       1 ── 1   Session（目标）
Plugin (piAgentHub 元数据) 1 ── n AgentRuntime（运行时）
```

| 实体 | 载体 | 说明 |
|---|---|---|
| HubUserConfig | `hub-service.json` users[] | 用户名/密码或哈希/角色/禁用 |
| DaemonTokenConfig | `hub-service.json` daemonTokens[] | name/token 或哈希/hostName/labels |
| SessionRow | SQLite `sessions` 表 + JSONL | hub 会话索引 + 镜像文件 |
| CanonicalEntry | JSONL 文件内 | pi v3 entry（11 类） |
| Session Chunk / Meta | 传输 DTO | daemon→hub 读取结果 |
| Delivery | SQLite `deliveries` 表 + 内存 Map | 下发任务（当前 Map 为准，见 §5） |
| TranscriptItem/Block | 传输 DTO | hub→console 正文渲染结构 |

---

## 2. SQLite schema（真实落地，`db.ts`）

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,             -- hubSessionId: hs_ + base64url(sha256)
  host_id TEXT NOT NULL,           -- 来自 daemon token hostName
  agent_id TEXT NOT NULL,
  native_id TEXT NOT NULL,         -- agent 原生 id
  native_path TEXT,                -- 镜像 JSONL 绝对路径
  cwd TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,     -- agent 侧更新时间（manifest 上报）
  last_timestamp INTEGER,          -- 已落盘最后一条 entry 的 ms（null=需全量）
  last_entry_id TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle',   -- active|idle|missing|error|deleted
  imported_from TEXT,
  UNIQUE (agent_id, native_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,             -- dlv_<uuid>
  host_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,             -- queued|dispatched|accepted|running|completed|failed|expired|canceled
  created_at INTEGER NOT NULL,
  error TEXT
);
```

> 与规划（docs/000 §5.6）相比，当前落地为精简版：无 `agents`/`entries`/`entries_fts`/`sse_events`/`audit` 表。

---

## 3. 配置模型（protocol 类型）

### 3.1 HubConfig / HubUserConfig / DaemonTokenConfig

```ts
HubUserConfig {
  username: string;
  password?: string;        // dev-only 明文
  passwordHash?: string;    // scrypt$salt$hash 格式
  role: "admin" | "viewer";
  disabled?: boolean;
}
DaemonTokenConfig {
  name: string;             // token 名称（作为 hostId 使用）
  token?: string;
  tokenHash?: string;       // sha256:
  hostName: string;
  labels?: string[];
}
HubConfig {
  server?: { port?, hostname?, publicUrl? };
  users: HubUserConfig[];
  daemonTokens: DaemonTokenConfig[];
  dataDir?: string;
  retentionDays?; maxSessionBytes?;
}
```

### 3.2 SyncDaemonConfig

```ts
SyncDaemonConfig {
  hub:   { url, token, tlsPin?, proxy?, heartbeatSeconds?, sse?: {retryMs?} };
  host:  { name, labels? };
  plugins: (string | {package,options?})[];
  pluginInstall?, pluginAllowlist?, pluginRoot?;
  agents: Record<string, AgentConfig>;   // {enabled?, instances?, options?, deliver?, import?}
  redaction?, limits?;
}
```

### 3.3 PluginMetadata（piAgentHub）

```ts
PluginMetadata {
  kind: AgentKind;             // pi|opencode|dsh|claude|codex
  protocolVersion: string;     // "1.0"
  minDaemonVersion: string;
  capabilities: PluginCapabilities;   // collect/deliver/import/losslessImport/exportNative/controlInterface/readStrategy/deliveryStrategy/largeReadMode/watch
  permissions?;                // fsRead/fsWrite/net/spawn
  timeouts?; maxConcurrency?; optionsSchema?;
}
```

---

## 4. Canonical entries（pi session format v3，`pi-session`）

### 4.1 基础形状

```ts
CanonicalEntry {
  type: string;         // 11 类之一
  id: string;
  parentId: string | null;   // 首条 null，其后=前一条 id（单链）
  timestamp: string;         // ISO 8601，单调不减
  [key: string]: unknown;    // 类型专属字段
}
SessionHeader {
  type: "session"; version?: number; id; timestamp; cwd; parentSession?;
}
```

> `validateEntries` 施加的规则（三层保障）：
> - (a) 字段形状：type/id/parentId/timestamp 必须存在；
> - (b) 单链：首条 parentId=null、第 i 条 parentId = 第 i-1 条 id；
> - (c) 唯一：id 不重复；timestamp 可解析为合法时间。

### 4.2 11 类 entry（规划，当前插件只产出子集）

| type | 产出方 | 说明 |
|---|---|---|
| message | pi / opencode（+dsh 未来） | 用户/助手/工具结果/bash |
| model_change / thinking_level_change / usage | pi | 元数据 |
| compaction / branch_summary | pi | 压缩/分支摘要 |
| custom | dsh（`{customType:"dsh.event"}`）、pi 导入来源标记 | 不进 LLM 上下文 |
| custom_message / context_edit / label / session_info | pi | 扩展 |

> 当前 dsh 插件把真实记录映射为 `custom`（类型 `dsh.event`）；opencode 映射为 `message`。

---

## 5. 下发/导入状态机（真实枚举）

| 对象 | 枚举 | 来源 |
|---|---|---|
| SessionState | active / idle / missing / error / deleted | protocol |
| DeliveryState | queued / dispatched / accepted / running / completed / failed / expired / canceled | protocol（当前落地 Map 只用到 queued/dispatched/accepted/completed/failed） |
| ImportState | queued / preparing / transferring / materializing / completed / failed | protocol |
| ManifestStatus | new / ok / skipped / full / quota / error | protocol（落地用到 new/ok/skipped） |

---

## 6. Transcript 数据模型（hub→console）

### 6.1 TranscriptItem

```ts
TranscriptItem {
  seq: number;               // 1 起，单调（仅按序，非持久）
  entryId: string;
  type: string;
  ts: number;                // ms
  role?: "user"|"assistant"|"tool"|"system"|"meta";
  blocks: TranscriptBlock[];
}
```

### 6.2 TranscriptBlock（11 种 kind）

| kind | 字段 | 说明 |
|---|---|---|
| text | text, markdown? | 纯文本/带 markdown 标记 |
| thinking | text | 思考（折叠） |
| toolCall | callId, name, input, status | 工具调用 |
| toolResult | callId?, name, ok, preview, bytes, truncated, rawUrl? | 工具结果预览 |
| image | mime, url, width?, height? | 图片引用 |
| bash | command, output, exitCode?, cancelled? | shell 执行 |
| summary | summaryType: compaction/branch, text, tokensBefore? | 摘要卡 |
| diff | files[{path,patch}] | diff（未来） |
| meta | label, detail?, level? | 元信息 |
| unknown | raw | 未知类型折叠 |

### 6.3 当前落地映射（`session-store.toTranscriptItem`）

- `message.role=user/assistant`：content 字符串 → text(markdown:true)；content 数组 → text/thinking/toolCall/image 分块。
- `toolResult` → role=tree，blocks 沿用；`bashExecution` → role=system + bash 块。
- `compaction`/`branch_summary` → summary 块；其他 → meta 块（label=type）。

---

## 7. 校验规则（从代码提取）

| 场景 | 规则 | 出处 |
|---|---|---|
| 会话同步 delta | 若 `timestamp < since` → 422 `entry_before_since` | app.ts |
| 会话同步 full | `validateEntries` 失败 → 422 `invalid_entry` | session-store.sync |
| 会话同步 delta | 已存在同 entryId → skipped；无效 timestamp → 报错 | session-store.sync |
| manifest | 新会话（无 (agentId,nativeId) 记录）→ `new` + 建行；updatedAt 未变 → `skipped` | app.ts |
| token 鉴权 | Bearer 缺失/未知 → 401 `token_unknown` | app.ts |
| console 写 | 无 Cookie → 401；CSRF 失败/viewer 调写 → 403 | app.ts |
