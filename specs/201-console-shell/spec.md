# 201-console-shell 功能规格（Specification）

> Module: 201-console-shell
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/hub-console/`

## 1. 模块概述

### 1.1 目的
hub-console 是 **hub-service 的前端（SPA）**：提供登录、会话列表、会话正文只读查看与主机列表，
通过 `/api/hub/*` 与 service 交互。当前为最小实现的脚手架。

### 1.2 解决的问题
- 为用户提供对镜像会话的只读查看入口（不引入 pi-web，自研渲染）。
- 演示会话身份/正文渲染/安全渲染（markdown 净化）的基本闭环。

### 1.3 范围
- 包含：登录、会话列表、会话详情（正文分块渲染）、主机列表、登出、API 客户端。
- 不包含：下发/导入界面、搜索页、多语言、分页虚拟列表（均 TODO）。

## 2. 用户故事
- 作为 admin，我可以登录后查看所有会话列表并进入某会话阅读正文。
- 作为 viewer，我可以查看（写操作会被服务端 403 拒绝）。
- 作为用户，我点击登出后回到登录页。

## 3. 功能需求

### 3.1 登录/登出
- FR-201-001: 登录成功 MUST 保存 CSRF token 并跳转 `/sessions`。
- FR-201-002: 登录失败 MUST 展示错误。
- FR-201-003: 登出 MUST 清除 Cookie 与会话 CSRF 并回 `/login`。

### 3.2 会话列表
- FR-201-004: 列表 MUST 展示 host/agent/cwd/title/entries/lastTimestamp（`SessionSummary`）。
- FR-201-005: 行点击 MUST 进入 `/sessions/:id`。
- FR-201-006: 刷新按钮 MUST 可重新拉取。

### 3.3 会话详情（只读正文）
- FR-201-007: MUST 展示标题与元信息（host/agent/cwd/entries）。
- FR-201-008: 正文 MUST 按 transcript block 渲染：text（markdown 净化）、thinking、toolCall、toolResult、bash、summary，其余显示 kind 标签。
- FR-201-009: Markdown 渲染 MUST `html:false` 并经 DOMPurify 净化（防 XSS）。
- FR-201-010: 正文 MUST 只读（无编辑/发送入口）。

### 3.4 主机列表
- FR-201-011: Hosts 页 MUST 展示 token 名 / host 名 / labels。

### 3.5 API 客户端
- FR-201-012: `api()` MUST 统一带 `Content-Type`（有 body 时）、写请求带 `X-CSRF-Token`、`credentials:"same-origin"`。
- FR-201-013: 非 2xx MUST 抛含状态码与 error 信息的异常。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| SessionSummary | 前端会话摘要 |
| TranscriptItem | 前端正文条目（blocks） |
| csrfKey (localStorage) | CSRF 持久化 |

## 5. 验收场景
### 场景：XSS 被净化
- Given 会话含 `<script>alert(1)</script>` 文本
- When 详情页渲染
- Then 不执行脚本（DOMPurify 后为文本）。

### 场景：登录链路
- Given 配置 admin 用户
- When 输入正确凭据提交
- Then 保存 csrf 并跳 /sessions。

### 场景：只读
- Given 详情页
- When 查找编辑/删除/发送控件
- Then 不存在。

## 6. 非功能需求
- base 路径 `/hub/`（路由与静态资源一致）；dev 由 Vite 代理 /api → 8443。
- 组件 Element Plus 全量引入（首屏体积优化 TODO）。

## 7. 假设与约束
- 依赖 hub-service 的同源 Cookie 会话（dev 同源跨端口经代理）。
- 无 i18n、无虚拟列表（当前直接渲染全部 items）。

## 8. 依赖
- 上游：`vue`、`vue-router`、`element-plus`、`markdown-it`、`dompurify`、`vite`。
- 数据源：hub-service `/api/hub/*`。
