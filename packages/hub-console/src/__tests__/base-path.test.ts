import { describe, expect, it } from "vitest";
import { deriveApiBase, deriveAppBase } from "../base-path.js";

describe("deriveAppBase — 应用 base 运行时推导", () => {
  it("直连部署：/hub/ 与 /hub/<route> 推导为 /hub/", () => {
    expect(deriveAppBase("/hub/")).toBe("/hub/");
    expect(deriveAppBase("/hub/login")).toBe("/hub/");
    expect(deriveAppBase("/hub/sessions/abc")).toBe("/hub/");
  });

  it("子路径反代：剥离 /hub 之前的外部前缀", () => {
    expect(deriveAppBase("/hub-service/hub/")).toBe("/hub-service/hub/");
    expect(deriveAppBase("/hub-service/hub/login")).toBe("/hub-service/hub/");
    expect(deriveAppBase("/hub-service/hub/sessions/abc?x=1")).toBe("/hub-service/hub/");
  });

  it("多级前缀同样适用（以最后一段 /hub 为锚点）", () => {
    expect(deriveAppBase("/a/b/hub/")).toBe("/a/b/hub/");
    expect(deriveAppBase("/a/b/hub/login")).toBe("/a/b/hub/");
  });

  it("无尾斜杠的应用根 /hub 也能识别", () => {
    expect(deriveAppBase("/hub")).toBe("/hub/");
    expect(deriveAppBase("/hub-service/hub")).toBe("/hub-service/hub/");
  });

  it("无法识别锚点时兜底为 /hub/（直连默认形态）", () => {
    expect(deriveAppBase("/")).toBe("/hub/");
    expect(deriveAppBase("/unknown/path")).toBe("/hub/");
  });
});

describe("deriveApiBase — API 基址与页面同源同前缀", () => {
  it("直连：/hub/ -> /api/", () => {
    expect(deriveApiBase("/hub/")).toBe("/api/");
  });

  it("子路径反代：/hub-service/hub/ -> /hub-service/api/", () => {
    expect(deriveApiBase("/hub-service/hub/")).toBe("/hub-service/api/");
  });

  it("多级前缀：/a/b/hub/ -> /a/b/api/", () => {
    expect(deriveApiBase("/a/b/hub/")).toBe("/a/b/api/");
  });
});
