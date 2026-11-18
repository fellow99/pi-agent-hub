# @pi-agent-hub/sync-plugin-opencode-cli

opencode 的 sync-daemon 插件（**基于 CLI 调用方式**：Node 子进程 + JSON-RPC/stdio，
插件内 spawn `opencode` CLI 完成采集/下发/模型信息）。

- 采集：`opencode session list --format json` / `opencode session export <id>`
- 模型信息：`opencode models`（纯文本投影，reasoning/thinking ⬜）
- 下发：`opencode run --session <id> --format json [--model] [--file] -- <message>`

与 `sync-plugin-opencode-serve`（HTTP 对接常驻 server）形成 opencode 宿主的两套接入实现。
kind=`opencode-cli`（与 serve 的 `opencode` 区分，daemon 可同时加载两套）。
