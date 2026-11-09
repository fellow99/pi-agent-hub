# @pi-agent-hub/hub-service

Express + `node:sqlite` 的中心服务（scaffold）。

- 配置：`~/.pi-agent-hub/hub-service.json`（也支持 `.yml`），用户 `admin/viewer` + 多个 `daemonTokens`；
- API：`/api/v1/*`（daemon）与 `/api/hub/*`（console）；
- 存储：`~/.pi-agent-hub/agent/sessions/**`（pi v3 JSONL），`hub.db` 索引；
- 已实现：登录/角色、manifest/sync、SSE、会话列表/正文/搜索；
- TODO：接入 pi SDK 只读 API（当前用 `@pi-agent-hub/pi-session` 解析）、上传流、导入/导出原生中转、完整重试。
