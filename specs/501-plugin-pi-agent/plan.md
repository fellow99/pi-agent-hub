# 501-plugin-pi-agent Technical Plan（As-Built）

> Module: 501-plugin-pi-agent
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM；内置 `node:fs/promises`、`node:child_process`、`node:readline`。
- 代码：`packages/sync-plugin-pi-agent/src/{main,plugin,pi-rpc}.ts`（24+263+86 行）。

## 2. Constitution 符合性
- ✅ 不改 native 存档（deliver 走 RPC；import 仅新建）。
- ✅ 输出 canonical pi v3（homeDir 解码、linearize 单链）。

## 3. 研究结论
- **元数据（piAgentHub）**：kind=pi、capabilities{collect,deliver,import,losslessImport,exportNative,controlInterface:"native-api",readStrategy:["storage"],deliveryStrategy:["api"],largeReadMode:"temp-file",watch:false}。
- **差异读取**：`since` 缺省 → full；否则 filter `timestampMs(entry) > since || (lastIndex>=0 && index>lastIndex)`（对应 docs/002 §4.3 的 tie-break 语义）。
- **大包阈值**：>2000 条或序列化 >4MiB → 写 `workDir/native/<id>.ndjson` + sha256（大包为 `sha256(serialized)` 即内容哈希）。
- **RPC 下发**（pi-rpc.ts）：stdout readline 读 JSON 事件；收到 `get_state` 成功响应 → 发 `prompt`；
  `prompt` 成功 → `agent_settled` 即结束；超时 kill。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | runPluginServer 装配 | 24 |
| src/plugin.ts | PiPlugin 逻辑 | 263 |
| src/pi-rpc.ts | promptPiSession | 86 |

## 5. 关键实现（对照 spec）
- `listSessions`：两级 readdir（project 目录 + jsonl 文件），`readSessionFile` 解析 header/entries（FR-501-003/004）。
- `readSession`：full → `linearize`；delta → filter 后直出；大包走文件（FR-501-005/006/007）。
- `deliver`：`findSessionPath`（not_found）→ `promptPiSession`（agent_error/timeout）（FR-501-008~010）。
- `importSession`：bundle 过滤 + validateEntries + `sessionFilePath` 写新文件（FR-501-011/012）。
- `exportNative`：`copyFile` 原始 JSONL + `sha256File`（FR-501-013）。

## 6. 测试考虑
- vitest + 采样会话（黄金样本）：list/read 差值、大包、validate、import 不覆盖（overall-test-cases T-501-001~005）。
