# 130-service-bootstrap 功能规格（Specification）

> Module: 130-service-bootstrap
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/hub-service/src/{config,main}.ts`

## 1. 模块概述

### 1.1 目的
hub-service 的**引导与配置**：加载 `hub-service.json`/`.yml`，确定性校验用户与 daemon token，
解析数据目录，组装 Express 应用并监听端口。

### 1.2 解决的问题
- 把「从哪里读配置、如何校验、数据目录在哪」从路由代码中隔离。
- 支持 JSON 与 YAML 两种配置格式（`HUB_CONFIG_FILE` 覆盖默认路径）。

### 1.3 范围
- 包含：配置路径解析、JSON/YAML 解析、字段校验、dataDir 派生、监听启动。
- 不包含：路由、鉴权、镜像（同前）。

## 2. 用户故事
- 作为运维，我可以把配置放到 `~/.pi-agent-hub/hub-service.json`（或 `.yml`）并启动 hub。
- 作为开发，我可以设 `HUB_CONFIG_FILE` 指向 `examples/hub-service.json` 快速起本地服务。

## 3. 功能需求
- FR-130-001: 配置路径 MUST 依次取：`--config` 参数（main 取 argv[2]）→ `HUB_CONFIG_FILE` → `~/.pi-agent-hub/hub-service.json`。
- FR-130-002: `.yml`/`.yaml` MUST 用 YAML 解析，否则 JSON 解析。
- FR-130-003: 配置根 MUST 是非对象时抛错。
- FR-130-004: `users` 过滤非法项后 MUST 至少 1 个，否则抛错。
- FR-130-005: `daemonTokens` 过滤非法项后 MUST 至少 1 个，否则抛错。
- FR-130-006: 用户项 MUST 具 username、role∈admin|viewer、password 或 passwordHash。
- FR-130-007: token 项 MUST 具 name、hostName、token 或 tokenHash。
- FR-130-008: `dataDir` MUST = 配置 `dataDir` ?? `PI_AGENT_HUB_HOME` ?? `~/.pi-agent-hub`（经 expandHome）。
- FR-130-009: 监听端口 MUST = 配置 `server.port` ?? `PORT` ?? 8443；host = 配置 `server.hostname` ?? `127.0.0.1`。
- FR-130-010: console 静态目录 MUST = `HUB_CONSOLE_DIR` ?? 相对 `hub-console/dist`（解析上一级目录）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| LoadedConfig | config + dataDir + configPath |

## 5. 验收场景
### 场景：缺用户拒绝启动
- Given 配置无 users 或全部非法
- When loadHubConfig
- Then 抛「requires at least one user」。

### 场景：YAML 支持
- Given `hub-service.yml`
- When loadHubConfig
- Then 正确解析并返回同构 config。

### 场景：数据目录覆盖
- Given 设置 `PI_AGENT_HUB_HOME=/data`
- When loadHubConfig（未配 dataDir）
- Then dataDir = /data。

## 6. 非功能需求
- 启动失败向 stderr 输出原因并 `exit(1)`（main 兜底）。
- 配置内容不落日志。

## 7. 假设与约束
- main 仅支持单个位置参数作为配置路径（未用 CLI 库）。
- `expandHome` 来自 `@pi-agent-hub/sync-plugin-sdk`（复用）。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`yaml`、`@pi-agent-hub/sync-plugin-sdk`。
- 下游：110-service-http（createApp 入参）、120-service-storage（dataDir）。
