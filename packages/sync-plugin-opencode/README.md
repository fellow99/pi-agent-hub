# @pi-agent-hub/sync-plugin-opencode

opencode 的 sync-daemon 插件（Node 子进程 + JSON-RPC/stdio）。

参考（外部工作区）：

- `../../../../opencode-workspace/opencode/packages/core/src/session/sql.ts`（`session_v2` / `session_message` / `session_part`）
- `../../../../opencode-workspace/opencode/packages/cli/src/database-path.ts`（`opencode.db`）
- `../../../../opencode-workspace/opencode/packages/cli/src/acp/agent.ts`（ACP）
- `../../../../opencode-workspace/opencode/packages/server/src/handlers/session.ts`（HTTP API）

实现状态：

- **直读 SQLite V2**（`session_v2` / `session_message` / `session_part`）已实现；
- V1 schema、ACP/HTTP 下发、导入仍为 TODO（明确报 `unsupported`）；
- 原生导出为 `session_message` JSON 快照。
