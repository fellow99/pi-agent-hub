# 503-plugin-dsh Technical Plan（As-Built）

> Module: 503-plugin-dsh
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM；内置 `node:zlib`（`zstdDecompressSync`）。
- 代码：`packages/sync-plugin-dsh/src/{main,plugin}.ts`（24+219 行）。

## 2. Constitution 符合性
- ✅ 只读直读采集；import 语义上不支持而不硬写（对应「不改 native」）。
- ✅ 归一 canonical（占位 custom 类型，符合「不要写入错误类型」的谨慎性）。

## 3. 研究结论
- **路径布局**（与 docs/000 §8.3 一致）：`<root>/--<cwd>--/<id>/session.vN.jsonl[.zstd]`；
  `scan` 三层 readdir，选版本最大文件（字典序 `.sort().pop()`）。
- **cwd 解码**：`--a-b--` → `a/b`（把 `-` 还原为 `/`，非 1:1 精确，但满足脚手架展示）。
- **记录归一**：每条记录映射为 `custom` + `customType:"dsh.event"` 的 entry，id 优先取记录 id，否则派生
  `<nativeId>-<index>`；timestamp 取记录 timestamp，缺失用文件 mtime 的 ISO（对应 FR-503-005）。
- **zstd**：Node 内置 `zstdDecompressSync`（FR-503-004）。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | runPluginServer 装配 | 24 |
| src/plugin.ts | DshPlugin 逻辑 | 219 |

## 5. 关键实现（对照 spec）
- `scan()`：root→project→session 三级，取版本最大文件与 mtime（FR-503-002）。
- `readRecords()`：按扩展名 zstd/raw 选择解码路径（FR-503-004）。
- `readSession()`：记录→entries，delta filter，full validate+linearize（FR-503-005/006）。
- `exportNative()`：`copyFile` 保留 `session.vN.jsonl[.zstd]` 原名（FR-503-009）。

## 6. 测试考虑
- vitest：构造 raw 与 zstd fixture 测 scan/read/export、版本选取、not_found（overall-test-cases T-503-001/002）。
