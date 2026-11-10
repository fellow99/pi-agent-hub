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
