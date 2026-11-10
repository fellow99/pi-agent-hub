# 210-console-shell Technical Plan（As-Built）

> Module: 210-console-shell
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 构建：Vite ^6.0.7 + `@vitejs/plugin-vue`；`base:"/hub/"`；dev `/api` 代理到 `127.0.0.1:8443`。
- 框架：Vue 3 ^3.5.13（`<script setup>`）、vue-router ^4.5.0（`createWebHistory("/hub/")`）。
- 组件库：Element Plus ^2.9.3（全量）+ icons。
- 安全：markdown-it ^14.1.0 + dompurify ^3.2.3。
- 代码：`packages/hub-console/src/*`（共 8 个源文件）。

## 2. Constitution 符合性
- ✅ 只读查看路径无写 UI（对应宪法「viewer 只读」）。
- ✅ 前端净化（markdown html:false + DOMPurify）符合渲染安全底线。

## 3. 研究结论
- 以「无全局状态库」的最小方案起步：组件内 `ref` + `onMounted` 拉取，`api.ts` 统一封装。
- CSRF 用 localStorage 键 `pi-agent-hub.csrf`；`api()` 对非 GET 写入 `X-CSRF-Token`（对应 FR-210-012）。
- 正文渲染按 `block.kind` 用 `v-if/v-else-if` 分支；text 经 `renderMarkdown`（md.render + sanitize）注入 `v-html`（对应 FR-210-008/009）。
- 默认载入最近 `tail=100` 条（`getTranscript` 固定 tail=100）；无 before 分页 UI（TODO）。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | 启动 | 8 |
| src/router.ts | 路由表 | 16 |
| src/App.vue | 布局壳 + 菜单 + 登出 | 28 |
| src/api.ts | API 客户端（CSRF/登录/会话） | 76 |
| src/styles.css | 全局样式 | 16 |
| src/views/Login.vue | 登录 | 42 |
| src/views/Sessions.vue | 会话列表 | 50 |
| src/views/SessionDetail.vue | 会话详情正文 | 75 |
| src/views/Hosts.vue | 主机列表 | 36 |
| vite.config.ts / index.html / tsconfig.json | 构建配置 | — |

## 5. 关键实现（对照 spec）
- `api()`：`headers.set("X-CSRF-Token", getCsrf())` 仅当 method≠GET；失败时从 body 提取 `error` JSON（对应 FR-210-012/013）。
- `SessionDetail`：`MarkdownIt({html:false, linkify:true, breaks:true})` + `DOMPurify.sanitize`（对应 FR-210-009）。
- block 分支：text/thinking/toolCall/toolResult/bash/summary/其他（对应 FR-210-008）。

## 6. 测试考虑
- Vitest @vue/test-utils：登录跳转、列表渲染、净化（XSS 样本）、登出（overall-test-cases T-210-001~004）。
