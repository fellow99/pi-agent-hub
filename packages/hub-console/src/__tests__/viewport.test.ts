import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPACT_MAX_WIDTH,
  NARROW_MAX_WIDTH,
  classifyViewport,
} from "../composables/viewport.js";

describe("classifyViewport", () => {
  it("narrow 区间同时命中 compact 与 narrow", () => {
    expect(classifyViewport(0)).toEqual({ isCompact: true, isNarrow: true });
    expect(classifyViewport(NARROW_MAX_WIDTH)).toEqual({ isCompact: true, isNarrow: true });
  });

  it("narrow 上界外只命中 compact", () => {
    expect(classifyViewport(NARROW_MAX_WIDTH + 1)).toEqual({ isCompact: true, isNarrow: false });
    expect(classifyViewport(COMPACT_MAX_WIDTH)).toEqual({ isCompact: true, isNarrow: false });
  });

  it("compact 上界外为宽屏，两者皆 false", () => {
    expect(classifyViewport(COMPACT_MAX_WIDTH + 1)).toEqual({ isCompact: false, isNarrow: false });
    expect(classifyViewport(1440)).toEqual({ isCompact: false, isNarrow: false });
  });

  it("断点常量固定为 1023/480，与 styles.css 媒体查询同源", () => {
    expect(COMPACT_MAX_WIDTH).toBe(1023);
    expect(NARROW_MAX_WIDTH).toBe(480);
  });

  it("styles.css 媒体查询断点与常量一致，防止 JS/CSS 双写漂移", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const mediaWidths = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
    // styles.css 中所有 max-width 断点必须来自 viewport.ts 常量集合
    expect(mediaWidths.length).toBeGreaterThan(0);
    for (const width of mediaWidths) {
      expect([COMPACT_MAX_WIDTH, NARROW_MAX_WIDTH]).toContain(width);
    }
    expect(mediaWidths).toContain(COMPACT_MAX_WIDTH);
    expect(mediaWidths).toContain(NARROW_MAX_WIDTH);
  });
});
