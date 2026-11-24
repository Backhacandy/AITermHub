// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { shouldNotify, shortBody, randomTopic, MIN_DONE_MS } from "./notify";

describe("notify", () => {
  it("보고 있는 탭은 알리지 않는다", () => {
    expect(shouldNotify({ kind: "error", title: "x" }, 0, true)).toBe(false);
    expect(shouldNotify({ kind: "error", title: "x" }, 0, false)).toBe(true);
  });
  it("짧게 끝난 작업의 완료는 알리지 않는다(오류·한도는 알림)", () => {
    expect(shouldNotify({ kind: "done", title: "x", startedAt: 0 }, MIN_DONE_MS - 1, false)).toBe(false);
    expect(shouldNotify({ kind: "done", title: "x", startedAt: 0 }, MIN_DONE_MS + 1, false)).toBe(true);
    expect(shouldNotify({ kind: "limit", title: "x", startedAt: 0 }, 10, false)).toBe(true);
  });
  it("본문은 첫 줄만 짧게(마크다운 기호 제거)", () => {
    expect(shortBody("\n## 완료했어요\n자세한 내용")).toBe("완료했어요");
    expect(shortBody("가".repeat(200)).length).toBe(120);
    expect(shortBody(undefined)).toBe("");
  });
  it("주제 이름은 aith- + 영문·숫자", () => {
    const t = randomTopic();
    expect(t).toMatch(/^aith-[a-z0-9]{9}$/);
    expect(randomTopic()).not.toBe(t);
  });
});
