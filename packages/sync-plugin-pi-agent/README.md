# @pi-agent-hub/sync-plugin-pi-agent

pi 的 sync-daemon 插件（Node 子进程 + JSON-RPC/stdio）。

参考：

- `../../../pi/packages/coding-agent/src/core/session-manager.ts`（session v3 格式、目录/文件名）
- `../../../pi/packages/coding-agent/docs/rpc.md`（`prompt` / `get_state` / `agent_settled`）
- `../../../pi-web/`（仅作为会话格式的消费者参考；本工程不引入 pi-web）

实现状态：

- 直读 `<agentDir>/sessions/**/*.jsonl`；`list_sessions` / `read_session` / `import_session` / `export_native` 已实现；
- `deliver` 通过 `pi --mode rpc --session <path>` 执行；
- 尚未接入 pi SDK 的 v1/v2 迁移（当前只按 v3 读取；README/规划已标注）。
