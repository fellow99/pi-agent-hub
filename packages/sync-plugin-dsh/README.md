# @pi-agent-hub/sync-plugin-dsh

deepseek-harness（dsh）的 sync-daemon 插件（Node 子进程 + JSON-RPC/stdio）。

参考（外部工作区）：

- `../../../../deepseek-harness-workspace/deepseek-harness/packages/session/session-persistence-jsonl/README.md`（目录布局/zstd）
- `../../../../deepseek-harness-workspace/deepseek-harness/packages/session/session-format/src/`（事件格式）

实现状态：

- 扫描 `session.v*.jsonl[.zstd]`，用 Node `zlib.zstdDecompressSync` 解码；
- 事件 → canonical 的字段映射仍为占位（`customType: "dsh.event"`），待真实样本校准；
- 下发/导入仍为 TODO。
