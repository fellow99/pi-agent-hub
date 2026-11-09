# @pi-agent-hub/sync-daemon-tray

Tauri v2 + 静态 HTML 的托盘/菜单栏程序：只做 daemon 守护 + 配置界面。

```bash
pnpm --filter @pi-agent-hub/sync-daemon-tray tauri:dev
pnpm --filter @pi-agent-hub/sync-daemon-tray tauri:build
```

需要 Rust/Cargo、Tauri CLI、平台 WebView2（Windows）/Xcode 工具链（macOS）。
当前仓库的 `pnpm build` 不构建 Rust，避免缺少 Cargo 时阻塞 JS 侧。
