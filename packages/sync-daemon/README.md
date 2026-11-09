# @pi-agent-hub/sync-daemon

Node 端侧守护进程：发现插件、manifest 差分同步、SSE 下发、本地控制 API。

```bash
node dist/main.js run --config ~/.pi-agent-hub/sync-daemon.json
```

已实现：插件发现/本地路径/npm 安装、JSON-RPC 子进程、manifest/sync、SSE、deliver/import/export_native 转发、控制 API。
TODO：upload 流、完整错误重试/退避、托盘联调。
