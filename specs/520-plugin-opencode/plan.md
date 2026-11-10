# 520-plugin-opencode Technical Plan（As-Built）

> Module: 520-plugin-opencode
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM；`node:sqlite`（`DatabaseSync`，readOnly）。
- 代码：`packages/sync-plugin-opencode/src/{main,plugin}.ts`（24+272 行）。

## 2. Constitution 符合性
- ✅ 只读直连存档（不改写 native）。
- ✅ 归一后为 canonical pi v3（复用 pi-session）。

## 3. 研究结论
- **版本识别**：查 `sqlite_master`，`session_v2`+`session_message` 存在 → schema=v2（对应 FR-520-003）。
- **SQL**：`session_message` 以 `(session_id, seq)` 排序；`session_part` 以 `(message_id, ordinal)` 排序；
  `messageContent` 聚合 text part（对应 FR-520-007）。
- **归一**：每条 message → `{type:"message", id, parentId=前一条id, timestamp, message:{role, content, timestamp}}`；
  role 来自 `message.data.role` 或 message.type（对应 FR-520-005）。
- 能力位 `deliver:true` 是元数据声明，但 `deliver()` 直接 throw unsupported——scope 与能力位不一致为已知简化（归入 510 方案 §6 提醒）。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | runPluginServer 装配 | 24 |
| src/plugin.ts | OpencodePlugin 逻辑 | 272 |

## 5. 关键实现（对照 spec）
- `dbPath()`：优先 options.dbPath；否则平台默认 dataDir 下探测 `opencode.db`（FR-520-002）。
- `open()`：readOnly + 版本判定（FR-520-003）。
- `readSession`：messages + parts 组装、delta filter、full validate+linearize（FR-520-005/006）。
- `exportNative`：`JSON.stringify({session, messages}, null, 2)` + sha256File（FR-520-008）。

## 6. 测试考虑
- vitest：构造 V2 SQLite fixture 测 list/read/export；无 V2 表断言 unsupported（overall-test-cases T-520-001~003）。
