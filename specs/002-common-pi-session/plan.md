# 002-common-pi-session Technical Plan（As-Built）

> Module: 002-common-pi-session
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM + TypeScript。
- 内置 API：`node:crypto`（sha256）、`node:fs/promises`（readFile）、`node:path`（join/resolve）。
- 代码：`packages/pi-session/src/index.ts`（114 行）。

## 2. Constitution 符合性
- ✅ 契约复用 protocol 的 `CanonicalEntry`/`SessionMeta`。
- ✅ 纯函数实现，封装 pi 格式细节（单一职责）。

## 3. 研究结论
- 编码规则参照 pi 上游 `session-manager.ts`（docs/000 附录 A 有锚点）：
  - `encodeSessionDir`：去掉首分隔符，`/ \ :` → `-`，包 `--`（对应 000 §5.1 事实）。
  - `sessionFileName`：`timestamp` 的 `[:.]` → `-`，`_<id>.jsonl`。
- 当前 hub-service 用本模块而非 pi SDK 解析：README 已标注 TODO（接入 `@earendil-works/pi-coding-agent` 只读 API）。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/index.ts | 全部解析/校验/编码/序列化 | 114 |

## 5. 关键实现（对照 spec）
- `validateEntries` 一次遍历收集全部错误（对应 FR-002-003/004）。
- `linearize` 基于数组下标重写 parentId（对应 FR-002-005）。
- `readSessionFile` 先 `find(isSessionHeader)` 定位 header，再 filter entries（对应 FR-002-001）。
- `sha256` 为纯内存哈希（供大包校验）。

## 6. 测试考虑
- 建议 vitest 覆盖：parse 容错、validate 各类坏链、linearize、编码稳定性、serialize 往返（overall-test-cases T-001-001~004）。
