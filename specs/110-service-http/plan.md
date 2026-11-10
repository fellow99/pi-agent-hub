# 110-service-http Technical Plan（As-Built）

> Module: 110-service-http
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM + Express 5（^5.3.0）。
- 代码：`packages/hub-service/src/app.ts`（340 行）、`auth.ts`（62 行）、`sse.ts`（43 行）。

## 2. Constitution 符合性
- ✅ API 前缀分轨（/api/v1 vs /api/hub）与幂等纪律（对应 constitution §5）。
- ✅ 安全底线：timingSafeEqual、CSRF、Cookie、角色（对应 constitution §6）。
- ⚠️ 会话/CSRF token 用内存 Map（无过期），符合 scaffold，但生产需持久化（TODO）。

## 3. 研究结论
- **分轨鉴权**：`/api/hub` 中间件先查 Cookie 会话，再对写请求校验 CSRF + admin；`/api/v1` 中间件
  校验 Bearer，token 以 `hashToken(token)` 预建 `hostByToken` Map 匹配（含明文回退）。
- **SSE 顶替**：`SseHub.add` 先对同 host 旧 client 写 `reset:superseded` + end，再 push 新 client（对应 FR-110-017）。
- **下发状态**：`deliveries` 用内存 Map 存 `{hostId, sessionId, state, createdAt}`；ack/result 更新状态；
  SSE 推送成功 → `dispatched`，否则 `queued`（对应 FR-110-014）。
- Express 5：async handler 无需手工 try/catch（rejected promise 传至错误中间件）。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/app.ts | Express 应用与全部路由 | 340 |
| src/auth.ts | 会话/Cookie/CSRF/密码/token | 62 |
| src/sse.ts | SseHub（每主机单连接） | 43 |

## 5. 关键实现（对照 spec）
- `/api/hub` 中间件一次完成「会话 → CSRF → 角色」三重校验（FR-110-003/004/005）。
- `verifyUser` 支持 `scrypt$salt$hash` 与明文（FR-110-006）；`hashToken` 用 sha256（FR-110-002）。
- `/api/v1/sync/sessions/:id` 的 `entry_before_since` 检查在 delta 且有 since 时执行，然后调用 `sessions.sync`（FR-110-009）。
- `createApp` 末尾 SPA 回退 regex `GET /.*/` → sendFile index.html（FR-110-016）。

## 6. 测试考虑
- vitest / 集成：用 supertest 风格（或直接 createApp + fetch）覆盖登录、角色、CSRF、manifest、
  SSE 顶替、搜索空参（overall-test-cases T-110-001~005、T-120-001/002/005）。
