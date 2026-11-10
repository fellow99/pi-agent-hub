# constitution.md — 宪法原则（从源码提取）

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：以下原则是从**当前源码可观察到的约定**中提取的**描述性**规则（"the codebase follows these principles"），
> 而非凭空规定。若实际实现与某条冲突，以源码为准并在此标注。

---

## 1. 语言与协作

- **交互/文档用中文，代码/变量/技术名词用英文**（仓库与父工程 AGENTS.md 约定）。
- **源码即真理**；表述不明必须标 `⬜ 待验证 / [NEEDS CLARIFICATION]`，不得臆测。
- 修复 Bug 只做最小改动，禁止顺手重构。

## 2. 包与模块组织

- **pnpm workspace + packages/ 单包单职责**：`protocol` 契约、`pi-session` 格式、`sync-plugin-sdk` 进程框架、
  `hub-service` 服务、`hub-console` 前端、`sync-daemon` 守护、`sync-plugin-*` 适配器、`sync-daemon-tray` 托盘。
- **公共包只放共享契约/工具**，不携带业务逻辑：`protocol` 是类型唯一来源，其他包以 `workspace:*` 依赖。
- 包命名遵循 scoped：`@pi-agent-hub/<name>`；插件用 `sync-plugin-<kind>`。

## 3. 类型与编译器纪律（tsconfig.base.json）

- **`strict: true`**；模块 `NodeNext`；目标 ES2022。
- 代码以 ESM（`"type":"module"`）发布；构建产物走 `dist/`，`files` 只含 `dist`。
- 禁止 `as any` / `@ts-ignore` / `@ts-expect-error` 压制；禁止空的 `catch(e) {}`（父工程规范）。

## 4. 架构边界

- **插件必须在子进程运行**（JSON-RPC over stdio），不在 daemon 进程内 `import` 执行（崩溃隔离）。
- **插件不直连 hub**；只与 daemon 通过 stdio JSON-RPC 通信。
- **插件不得改写 native 存档**（唯一例外：`import_session` 新建）；`deliver` 必须走 agent 自身接口。
- **daemon 不解析任何 agent 格式**；解析/归一全部由插件承担；脱敏由 daemon 侧统一（当前尚未实现脱敏，属 TODO）。
- **hub-service 只写自己的 `~/.pi-agent-hub`**（`hub.db` + `agent/sessions/**`），不写主机 native 存档。
- **统一数据契约 = pi session format v3**（canonical entries，不含 header，单链）。

## 5. API 与协议约定

- daemon API 前缀 `/api/v1/*`（Bearer token）；console API 前缀 `/api/hub/*`（Cookie + CSRF）。
- 会话 ID 派生：`hubSessionId = hs_ + sha256(hostId\0agentId\0nativeId)[:26]`，**确定性+命名空间隔离**。
- 状态/错误用稳定枚举（`new/ok/skipped/full/quota/error`；`token_unknown/csrf_failed/forbidden_role/…`）。
- 幂等：同 `(agentId, nativeId)` 会话 upsert；同 `entryId` 去重；delivery 用 `deliveryId`。

## 6. 安全底线

- 用户角色仅 `admin` / `viewer`（无 RBAC）；密码支持明文（dev）与哈希（scrpyt$）。
- daemon token 支持明文/`sha256:` 哈希；`auth.ts` 的 `safeEqual` 用 `timingSafeEqual` 防时序攻击。
- console Cookie：`HttpOnly + SameSite=Lax`；写接口校验 CSRF + admin 角色。
- 本地控制 API：随机 token 写 `daemon-control.json`（`0600`），`127.0.0.1` 监听。
- 前端 Markdown：`markdown-it {html:false}` + DOMPurify 净化。
- 日志不得记录 token/消息正文（当前 Logger 仅记录摘要/错误串）。

## 7. 质量与验证

- 每个包有 `build` / `typecheck` / `test` 脚本；根脚本递归执行。
- `test` 当前为占位（`--passWithNoTests`），真实测试是 TODO。
- 依赖以 `workspace:*` 引用同仓包；外部依赖版本明确（`^`）并 **未提交锁遗漏**（pnpm-lock.yaml 已入库）。

## 8. 已知偏离（观测而非规则）

- 规划要求（docs/000）的 pi SDK 只读解析、upload 流、FTS5 搜索、托盘完整生命周期等**尚未落地**，均属 TODO。
- hub-service 的 SSE 事件 `id` 用 `Date.now()`，未持久化到事件表（无断线重放）。
