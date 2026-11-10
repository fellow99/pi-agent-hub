# overall-test-cases.md — 测试用例索引

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：本文件是**全系统测试用例的索引目录**。当前各包 `test` 脚本为占位（`vitest run --passWithNoTests`），
> 以下用例多数为**规划性/待测（TODO）**，依据协议契约（docs/001）与本工程模块拆解而来；落地后按模块补充分文件。

---

## 1. 测试分层与工具

| 层 | 工具 | 目标路径 | 状态 |
|---|---|---|---|
| 单元（公共逻辑） | vitest | 各包 `src/**/*.test.ts` | ⬜ 占位 |
| 契约（daemon↔hub） | vitest + 协议 fixture | `specs/*/plan.md` 标记 | ⬜ TODO |
| 插件契约 | vitest + JSON-RPC fixture | sync-plugin-sdk | ⬜ TODO |
| 前端组件 | vitest + @vue/test-utils | hub-console | ⬜ TODO |
| 端到端 | 本地 examples 手测 / Playwright | 3 进程联调 | 🔶 可手测 |

> 运行：`pnpm test`（递归，当前全占位）。

---

## 2. 用例索引（按模块）

### 2.1 公共：protocol / pi-session / plugin-sdk

| 用例 | 断言 | 归属模块 |
|---|---|---|
| T-001-001 pi-session 解析 | `parseJsonLines` 忽略坏行但保留合法行 | 002-common-pi-session |
| T-001-002 校验规则 | 单链/首条 parentId=null/id 唯一/非法 timestamp 给出错误 | 002-common-pi-session |
| T-001-003 linearize | 输入未链化 entries → 输出单链 | 002-common-pi-session |
| T-001-004 编码 | opencode/dsh 的 encodeSessionDir/sessionFileName 与 pi 一致 | 002-common-pi-session |
| T-001-005 JSON-RPC 帧 | client/server 对 NDJSON 编解码正确 | 003-common-plugin-sdk |
| T-001-006 错误归一 | 任意 throw → PluginError code 默认 internal | 003-common-plugin-sdk |

### 2.2 hub-service

| 用例 | 断言 | 归属模块 |
|---|---|---|
| T-102-001 manifest 新建 | 新 (agentId,nativeId) → status=new、lastTimestamp=null、建行 | 102-service-storage |
| T-102-002 manifest 跳过 | updatedAt 未变 → status=skipped | 102-service-storage |
| T-102-003 full 同步 | 全量落盘 JSONL 合法、水位推进、可再读 | 102-service-storage |
| T-102-004 delta 去重 | 重复 entryId 计入 skipped，不重复落盘 | 102-service-storage |
| T-102-005 delta 越界 | timestamp<since → 422 entry_before_since | 101-service-http |
| T-102-006 幂等 upsert | 同会话重复 manifest 不产生新行 | 102-service-storage |
| T-102-007 transcript | 各类型 entry → 对应 block（text/thinking/toolCall/summary/meta） | 102-service-storage |
| T-101-001 token 鉴权 | 未知/缺失 Bearer → 401 token_unknown | 101-service-http |
| T-101-002 console 鉴权 | 无 Cookie → 401；viewer 调写 → 403；CSRF 错 → 403 | 101-service-http |
| T-101-003 登录 | 正确密码 → Cookie+csrf；错误 → 401 invalid_credentials | 101-service-http |
| T-101-004 SSE 顶替 | 同 host 新连接顶替旧连接（旧收 reset） | 101-service-http |
| T-101-005 只读 | 会话内容端点仅 GET；POST/PUT/DELETE 不存在 | 101-service-http |
| T-102-008 搜索 | q 空 → 400；title/cwd 命中返回 | 102-service-storage |

### 2.3 hub-console

| 用例 | 断言 | 归属模块 |
|---|---|---|
| T-201-001 登录页 | 登录成功跳 /sessions；失败显示错误 | 201-console-shell |
| T-201-002 会话列表 | 渲染 host/agent/cwd/title/entries；行点击进详情 | 201-console-shell |
| T-201-003 会话详情 | 各 block 渲染；markdown 净化（script 不执行） | 201-console-shell |
| T-201-004 登出 | 清 Cookie/CSRF 回 /login | 201-console-shell |

### 2.4 sync-daemon

| 用例 | 断言 | 归属模块 |
|---|---|---|
| T-401-001 配置校验 | 缺 hub.url/token/host.name/plugins → 启动报错 | 401-sync-daemon |
| T-401-002 插件加载 | 本地路径解析→spawn→initialize→detect | 401-sync-daemon |
| T-401-003 动态安装 | allowlist 命中→npm install→resolve | 401-sync-daemon |
| T-401-004 manifest/差分 | 按 hub 水位读 read_session→sync | 401-sync-daemon |
| T-401-005 SSE 事件 | deliver/import/export_native 分派正确 | 401-sync-daemon |
| T-401-006 断线重连 | SSE 断→指数重连（3s 兜底） | 401-sync-daemon |
| T-401-007 控制 API | status/pause/resume/sync-now/logs/quit 带 token | 401-sync-daemon |

### 2.5 插件

| 用例 | 断言 | 归属模块 |
|---|---|---|
| T-501-001 pi list_sessions | 扫描 sessions/**/*.jsonl；updatedAt 正确 | 501-plugin-pi-agent |
| T-501-002 pi read_session | since 差分/全量；大包 entriesPath+sha256 | 501-plugin-pi-agent |
| T-501-003 pi deliver | `pi --mode rpc` prompt 执行并 settle | 501-plugin-pi-agent |
| T-501-004 pi import | 新 id 新建 JSONL，不覆盖 | 501-plugin-pi-agent |
| T-501-005 pi export_native | 复制原始 JSONL + sha256 | 501-plugin-pi-agent |
| T-502-001 opencode list/read | 直读 SQLite V2（session_v2/message/part） | 502-plugin-opencode |
| T-502-002 opencode 版本 | 无 session_v2 → unsupported | 502-plugin-opencode |
| T-502-003 opencode deliver/import | 未接线 → unsupported | 502-plugin-opencode |
| T-503-001 dsh list/read | 直读 session.vN.jsonl(.zstd) | 503-plugin-dsh |
| T-503-002 dsh deliver/import | 未接线/不支持 → unsupported | 503-plugin-dsh |

### 2.6 托盘

| 用例 | 断言 | 归属模块 |
|---|---|---|
| T-301-001 守护 | start→daemon 进程存活；stop→停止 | 301-tray-supervisor |
| T-301-002 配置 | read_config/write_config 读写 sync-daemon.json | 301-tray-supervisor |

### 2.7 部署

| 用例 | 断言 | 归属 |
|---|---|---|
| T-900-001 compose 校验 | `docker compose config` 合法 | deploy |
| T-900-002 路由 | /hub/ → console；/api/ → hub-service；SSE 关缓冲 | deploy |
| T-900-003 数据卷 | ./data 映射 ~/.pi-agent-hub 持久化 | deploy |

---

## 3. 填写说明

- 每模块对应的详细测试用例建议在各自 `NNN-*/` 目录的 `plan.md`「Testing Considerations」中补充分文件 `test-cases.md`。
- 已实现的功能（manifest/sync/transcript/SSE 顶替/鉴权）应优先补 vitest 单测。
- 端到端联调：本地 `examples/` 起 hub + console + daemon 可手测主链路。
