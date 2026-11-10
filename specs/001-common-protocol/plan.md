# 001-common-protocol Technical Plan（As-Built）

> 本文档为回顾性技术方案，记录实际的架构、设计与实现策略。
> Module: 001-common-protocol
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM + TypeScript，无第三方依赖。
- 代码：`packages/protocol/src/index.ts`（单文件，301 行，全部类型/常量）。

## 2. Constitution 符合性
- ✅ 单包单职责（契约包）。
- ✅ 类型严格（全部 interface/type，无 any/抑制）。

## 3. 研究结论
- 采用「类型即文档」策略：所有契约以 TS 类型表达，避免额外维护 schema 文件。
- 规划曾提及 JSON Schema（docs/001 §12）与 fixture，当前未落地（TODO）。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/index.ts | 全部类型与常量 | 301 |

## 5. 关键实现（对照 spec）
- 用 `export type`/`interface` 表达 DTO；`as const` 表达版本常量（实现 FR-001-001）。
- `CanonicalEntry` 用 `[key: string]: unknown` 容纳 pi 各类专属字段（对应 FR-001-009）。
- `PluginCapabilities.controlInterface` 固定为 `"acp" | "native-api" | "cli" | null`（对应 FR-001-011）。

## 6. 测试考虑
- 类型级测试价值低；建议以「编译通过 + 契约 fixture」验证（归入 overall-test-cases T-010 系列）。
