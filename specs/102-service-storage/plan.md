# 102-service-storage Technical Plan（As-Built）

> Module: 102-service-storage
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM + `node:sqlite`（`DatabaseSync`，同步 API）。
- 代码：`packages/hub-service/src/db.ts`（92 行）、`session-store.ts`（170 行）。

## 2. Constitution 符合性
- ✅ 统一 pi v3 存储与单链契约（复用 pi-session，对应 constitution §4）。
- ✅ 只写自身数据目录（对应宪法「hub 不写 native」）。

## 3. 研究结论
- 采用 **JSONL 事实源 + SQLite 索引**：镜像在 `dataDir/agent/sessions/**`，索引在 `hub.db`；
  与规划（000 §5.6）一致，但落地为精简 schema（无 entries/entries_fts/audit 表）。
- `node:sqlite` 同步 API 在 scaffold 阶段足够；规划曾博弈 better-sqlite3 vs node:sqlite（000 §14.5），当前采用 node:sqlite。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/db.ts | Store（建表/查询/upsert） | 92 |
| src/session-store.ts | SessionStore（身份/合并/transcript/readEntry） | 170 |

## 5. 关键实现（对照 spec）
- `hubSessionId`：`sha256(...).digest("base64url").slice(0,26)`（对应 FR-102-001）。
- `sync` 合并（FR-102-006/007/009）：
  - full：`validateEntries` → `writeFile(tmp)` → `rename(tmp,path)`；
  - delta：`existingIds` 来自现有文件 entries，过滤后追加（`flag:"a"`），无文件则新写；
  - 统一读回 `readSessionFile` 计算最新水位与 entry_count/bytes，upsert 行。
- `transcript`（FR-102-011）：读文件 → 全部 map 为 item → `before` 过滤 → `slice(-tail)`；
  返回 `hasMore = filtered.length > sliced.length`。
- `toTranscriptItem` 映射：message role 分发 text/thinking/toolCall/image、toolResult→tool、bashExecution→bash、
  compaction/branch_summary→summary、其余→meta（对应 000 §6.2 简化版）。

## 6. 测试考虑
- vitest：full/delta 合并、幂等去重、hubSessionId 确定性、transcript 分页边界（overall-test-cases T-102-003~008）。
