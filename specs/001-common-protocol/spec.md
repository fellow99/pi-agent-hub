# 001-common-protocol 功能规格（Specification）

> Module: 001-common-protocol
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/protocol/src/index.ts`

## 1. 模块概述

### 1.1 目的
作为全仓库**契约与类型的唯一来源**：定义 hub ↔ daemon ↔ console ↔ 插件之间所有共享数据类型、
配置模型、状态枚举与协议版本常量，使各包在 `workspace:*` 依赖下共享同一套「事实」。

### 1.2 解决的问题
- 避免各包各自定义 `SessionSummary`、`ManifestRequest` 导致类型漂移。
- 为 daemon API（`/api/v1/*`）与插件 JSON-RPC 提供统一入参/出参类型。
- 为 transcript 渲染提供块级数据契约。

### 1.3 范围
- 包含：类型、常量（协议版本）、DTO、配置接口、能力位。
- 不包含：任何运行时逻辑、I/O、业务行为。

## 2. 用户故事
- 作为 hub-service 开发者，我可以 import `Protocol` 类型而无需关心其他包的内部结构。
- 作为插件作者，我可以依据 `protocol` 的能力位声明正确编写 `piAgentHub` 元数据。

## 3. 功能需求

### 3.1 版本常量
- FR-001-001: 模块 MUST 导出 `PROTOCOL_VERSION = "1.0"` 与 `PLUGIN_PROTOCOL_VERSION = "1.0"`。

### 3.2 枚举与状态
- FR-001-002: MUST 定义 `AgentKind`、`UserRole`、`SessionState`、`DeliveryState`、`ImportState`。
- FR-001-003: Manifest 结果状态 MUST 为 `new|ok|skipped|full|quota|error`。

### 3.3 配置模型
- FR-001-004: MUST 提供 `HubConfig`（server/users/daemonTokens/dataDir/…）。
- FR-001-005: MUST 提供 `SyncDaemonConfig`（hub/host/plugins/pluginInstall/agents/…）。
- FR-001-006: MUST 提供 `PluginMetadata`（piAgentHub 元数据，含 capabilities/permissions/timeouts）。

### 3.4 同步/下发 DTO
- FR-001-007: MUST 提供 manifest 请求/响应、sync 请求/响应、SessionMeta、ManifestSessionResult。
- FR-001-008: MUST 提供 `NativeSessionMeta`、`SessionChunk`、`DeliverRequest/Result`、`ImportRequest/Result`、`ExportNativeRequest/Result`。
- FR-001-009: MUST 定义 `CanonicalEntry`（pi v3 entry 基类）。

### 3.5 transcript 契约
- FR-001-010: MUST 定义 `TranscriptItem` 与 11 种 `TranscriptBlock`（text/thinking/toolCall/toolResult/image/bash/summary/diff/meta/unknown）。

### 3.6 插件能力位
- FR-001-011: MUST 定义 `PluginCapabilities`（collect/deliver/import/losslessImport/exportNative/controlInterface/readStrategy/deliveryStrategy/largeReadMode/watch）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| HubConfig | hub 配置 | server, users, daemonTokens, dataDir |
| SyncDaemonConfig | daemon 配置 | hub, host, plugins, pluginInstall, pluginAllowlist, agents |
| PluginCapabilities | 插件能力声明 | collect, deliver, import, controlInterface, readStrategy |
| TranscriptBlock | 正文渲染块 | kind, text, callId, name, preview, url, … |

## 5. 验收场景

### 场景：协议版本一致
- Given 各包依赖 `@pi-agent-hub/protocol`
- When import `PROTOCOL_VERSION`
- Then 全仓库均为 `"1.0"`，插件握手可用同一值判定。

### 场景：类型复用
- Given hub-service 与 sync-daemon 不同包
- When 均 `import type { ManifestRequest }`
- Then 编译通过且语义一致。

## 6. 非功能需求
- 纯类型包：零运行时依赖、零 I/O；`private: true`。
- 向后兼容：同版本内只允许新增可选字段。

## 7. 假设与约束
- 类型由业务代码单方面消费，不直接承载校验逻辑（校验在 pi-session / 各入口进行）。

## 8. 依赖
- 上游：无。
- 下游：`pi-session`、`sync-plugin-sdk`、`hub-service`、`sync-daemon`、`sync-plugin-*` 均以 `workspace:*` 依赖。
