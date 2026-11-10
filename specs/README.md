# 规格文档索引

**项目名称：** pi-agent-hub（多智能体会话汇总、只读查看与下发服务）
**版本：** 0.1.0（scaffold）
**技术栈：** pnpm workspace · Node(>=22.19) + TS · Express 5 + node:sqlite · Vue 3 + Element Plus · Tauri v2 · JSON-RPC over stdio
**文档生成时间：** 2026-11-10
**最后更新：** 2026-11-10

---

## 一、文档总览

| 层级 | 分类 | 文档数量 | 说明 |
|------|------|---------|------|
| 整体 | 项目级顶层文档 | 10 | 结构、技术、架构、宪法、整体规格/方案/数据模型/测试、检查清单（含索引 README） |
| 模块 | 公共模块（0XX） | 3 目录 / 6 文件 | protocol、pi-session、plugin-sdk |
| 模块 | hub-service（1XX） | 3 目录 / 6 文件 | HTTP 边缘、存储同步、引导 |
| 模块 | hub-console（2XX） | 1 目录 / 2 文件 | console 前端 |
| 模块 | sync-daemon-tray（3XX） | 1 目录 / 2 文件 | Tauri 托盘 |
| 模块 | sync-daemon（4XX） | 1 目录 / 2 文件 | 端侧守护 |
| 模块 | sync-plugin-*（5XX） | 3 目录 / 6 文件 | pi / opencode / dsh 插件 |
| **合计** | | **12 目录 / 34 文件** | |

> 项目级顶层文档 10 个 + 模块级 12 目录（24 个 spec/plan 对）= 34 个文档文件。

---

## 二、项目级顶层文档

全局性的架构、技术、宪法等文档，定义项目基线和开发准则。

| 文档 | 路径 | 说明 |
|------|------|------|
| **方案总纲** | [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统整体架构（含规划 vs 落地差异表） |
| **技术选型** | [TECH.md](./TECH.md) | 核心技术栈、依赖版本、选型要点 |
| **宪法原则** | [constitution.md](./constitution.md) | 从源码提取的项目原则与既有约定 |
| **项目结构** | [STRUCTURE.md](./STRUCTURE.md) | 目录/文件地图、路由清单、配置位置 |
| **检查清单** | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) | 规格文档完成度追踪 |

### 整体规格文档

描述跨模块的全局规格、方案与数据模型。

| 文档 | 路径 | 说明 |
|------|------|------|
| **整体规格** | [overall-spec.md](./overall-spec.md) | 系统级功能规格（用户故事 + FR/NFR） |
| **整体方案** | [overall-plan.md](./overall-plan.md) | 系统级技术方案（as-built） |
| **数据模型** | [overall-data-model.md](./overall-data-model.md) | 全局实体、SQLite schema、canonical、状态机、transcript |
| **测试用例索引** | [overall-test-cases.md](./overall-test-cases.md) | 全模块测试用例索引总览 |

---

## 三、公共模块（0XX）

### 001 — 公共协议（protocol）

> 全仓库契约与类型的唯一来源：配置模型、DTO、状态枚举、能力位、transcript 块。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [001-common-protocol/spec.md](./001-common-protocol/spec.md) | 契约范围与需求 |
| 技术方案 | [001-common-protocol/plan.md](./001-common-protocol/plan.md) | 类型组织实现 |

### 002 — pi 会话处理（pi-session）

> pi session format v3 的解析/校验/线性化/编码/序列化基座。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [002-common-pi-session/spec.md](./002-common-pi-session/spec.md) | 校验规则与编码契约 |
| 技术方案 | [002-common-pi-session/plan.md](./002-common-pi-session/plan.md) | 与 pi 上游对齐的实现 |

### 003 — 插件进程框架（sync-plugin-sdk）

> 插件 = 子进程 + JSON-RPC over stdio 的双侧框架（server/client）与错误归一。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [003-common-plugin-sdk/spec.md](./003-common-plugin-sdk/spec.md) | 进程边界与协议纪律 |
| 技术方案 | [003-common-plugin-sdk/plan.md](./003-common-plugin-sdk/plan.md) | NDJSON/RpcClient 实现 |

---

## 四、hub-service（1XX）

### 101 — HTTP 边缘与 API（http）

> Express 应用、daemon/console 鉴权、SSE 下行、静态托管。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [101-service-http/spec.md](./101-service-http/spec.md) | 路由、鉴权、SSE 需求 |
| 技术方案 | [101-service-http/plan.md](./101-service-http/plan.md) | 分轨鉴权与 SseHub 实现 |

### 102 — 存储与同步（storage）

> SQLite 会话索引、hubSessionId 派生、同步合并（JSONL 镜像）、transcript、搜索过滤。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [102-service-storage/spec.md](./102-service-storage/spec.md) | 合并语义与读取契约 |
| 技术方案 | [102-service-storage/plan.md](./102-service-storage/plan.md) | 事实源 + 索引实现 |

### 103 — 配置与引导（bootstrap）

> 配置加载（JSON/YAML）、校验、数据目录派生与监听启动。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [103-service-bootstrap/spec.md](./103-service-bootstrap/spec.md) | 配置优先序与校验 |
| 技术方案 | [103-service-bootstrap/plan.md](./103-service-bootstrap/plan.md) | 引导实现 |

---

## 五、hub-console（2XX）

### 201 — 前端壳（console-shell）

> Vue3 SPA：登录、会话列表、会话正文只读查看、主机列表、API 客户端。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [201-console-shell/spec.md](./201-console-shell/spec.md) | 页面与渲染安全需求 |
| 技术方案 | [201-console-shell/plan.md](./201-console-shell/plan.md) | Vite/Vue3 组装与净化实现 |

---

## 六、sync-daemon-tray（3XX）

### 301 — 托盘守护（tray-supervisor）

> Tauri v2 托盘 + 配置界面：守护 daemon、start/stop/status、读写 sync-daemon.json。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [301-tray-supervisor/spec.md](./301-tray-supervisor/spec.md) | 守护与配置界面需求 |
| 技术方案 | [301-tray-supervisor/plan.md](./301-tray-supervisor/plan.md) | Tauri/Rust 实现 |

---

## 七、sync-daemon（4XX）

### 401 — 端侧守护进程（sync-daemon）

> 插件管理、manifest→差分→同步、SSE 事件分派、本地控制 API。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [401-sync-daemon/spec.md](./401-sync-daemon/spec.md) | 同步/下行/控制需求 |
| 技术方案 | [401-sync-daemon/plan.md](./401-sync-daemon/plan.md) | 插件/spawn 与事件循环实现 |

---

## 八、sync-plugin-*（5XX）

### 501 — pi 插件（plugin-pi-agent）

> pi 会话读取（原生即 canonical）、RPC 下发、导入与原生导出。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [501-plugin-pi-agent/spec.md](./501-plugin-pi-agent/spec.md) | 读取/下发/导入需求 |
| 技术方案 | [501-plugin-pi-agent/plan.md](./501-plugin-pi-agent/plan.md) | 差异读取与 RPC 实现 |

### 502 — opencode 插件（plugin-opencode）

> 直读 opencode SQLite V2，归一 canonical；deliver/import 未接线。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [502-plugin-opencode/spec.md](./502-plugin-opencode/spec.md) | 版本识别与读取需求 |
| 技术方案 | [502-plugin-opencode/plan.md](./502-plugin-opencode/plan.md) | SQLite V2 组装实现 |

### 503 — dsh 插件（plugin-dsh）

> 直读 dsh session.vN.jsonl[.zstd]，归一 canonical（custom 占位）；deliver/import 不支持。

| 文档 | 链接 | 说明 |
|------|------|------|
| 功能规格 | [503-plugin-dsh/spec.md](./503-plugin-dsh/spec.md) | zstd 读取与归一需求 |
| 技术方案 | [503-plugin-dsh/plan.md](./503-plugin-dsh/plan.md) | 扫描/解码实现 |

---

## 九、模块编号一览

| 编号 | 模块名 | 英文名 | 分类 |
|------|--------|--------|------|
| 001 | 公共协议 | protocol | 公共（0XX） |
| 002 | pi 会话处理 | pi-session | 公共（0XX） |
| 003 | 插件进程框架 | sync-plugin-sdk | 公共（0XX） |
| 101 | HTTP 边缘与 API | service-http | hub-service（1XX） |
| 102 | 存储与同步 | service-storage | hub-service（1XX） |
| 103 | 配置与引导 | service-bootstrap | hub-service（1XX） |
| 201 | 前端壳 | console-shell | hub-console（2XX） |
| 301 | 托盘守护 | tray-supervisor | sync-daemon-tray（3XX） |
| 401 | 端侧守护进程 | sync-daemon | sync-daemon（4XX） |
| 501 | pi 插件 | plugin-pi-agent | sync-plugin（5XX） |
| 502 | opencode 插件 | plugin-opencode | sync-plugin（5XX） |
| 503 | dsh 插件 | plugin-dsh | sync-plugin（5XX） |

> 注：编号连续无跳号（scaffold 阶段）。

---

## 十、模块文档结构规范

每个模块目录 `NNN-name/` 下包含以下标准文档：

| 文件 | 命名 | 说明 |
|------|------|------|
| 功能规格 | `spec.md` | 定义模块的功能需求、用户故事、验收标准 |
| 技术方案 | `plan.md` | 模块的技术实现方案（as-built）、文件清单 |

> 如项目需要，模块目录还可扩展：`tasks.md`、`api.md`、`data-model.md`、`pages.md`、`test-cases.md`
> （本阶段未覆盖，overall-test-cases.md 已有索引预留）。

---

## 十一、快速导航

| 目标读者 | 推荐阅读顺序 |
|---------|-------------|
| **新加入开发者** | constitution.md → STRUCTURE.md → overall-spec.md → 对应模块 spec.md |
| **架构师 / Tech Lead** | ARCHITECTURE.md → TECH.md → overall-plan.md |
| **后端开发** | overall-data-model.md → 101/102/103 模块 |
| **前端开发** | STRUCTURE.md → 201-console-shell |
| **端侧/插件开发** | 401-sync-daemon → 501/502/503 插件 |
| **测试 / QA** | overall-test-cases.md → SPECS_CHECKLIST.md |
| **产品经理** | overall-spec.md → 模块 spec.md |

---

**文档维护者：** pi-agent-hub 开发团队
