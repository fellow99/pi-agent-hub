# 103-service-bootstrap Technical Plan（As-Built）

> Module: 103-service-bootstrap
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM；`yaml` ^2.7.0（YAML 解析）。
- 代码：`packages/hub-service/src/config.ts`（46 行）、`main.ts`（22 行）。

## 2. Constitution 符合性
- ✅ 配置强校验（缺用户/token 即拒）符合「不臆测、尽早失败」。

## 3. 研究结论
- 用 `expandHome`（来自 sync-plugin-sdk）统一展开 `~` 与相对路径。
- `isRecord` 守卫 + `isHubUser`/`isDaemonToken` 过滤：非法项丢弃而非报错（宽松），但为空集合时报错（保守启动）——这是有意的「容错解析、严格门槛」策略。
- YAML 与 JSON 用扩展名分支（`.yml`/`.yaml` → yaml），其余 JSON。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/config.ts | loadHubConfig 与校验 | 46 |
| src/main.ts | 引导，监听 | 22 |

## 5. 关键实现（对照 spec）
- 配置路径优先级：argv[2] → `HUB_CONFIG_FILE` → 默认 `~/.pi-agent-hub/hub-service.json`（FR-103-001）。
- `dataDir`：`config.dataDir ?? PI_AGENT_HUB_HOME ?? ~/.pi-agent-hub`（FR-103-008）。
- `consoleDir`：`HUB_CONSOLE_DIR ?? <repo>/packages/hub-console/dist` 通过 `fileURLToPath(import.meta.url)` 上溯（FR-103-010）。
- 端口/主机：`server.port ?? process.env.PORT ?? 8443`；`server.hostname ?? 127.0.0.1`（FR-103-009）。

## 6. 测试考虑
- vitest：路径优先级、YAML/JSON 解析、缺 user/token 抛错、dataDir 覆盖（overall-test-cases 建议新增 T-130 系列）。
