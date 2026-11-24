// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { nightActive, nightAutoApproves, noteResult, startNight, NIGHT_FAILS } from "./night";

describe("밤새 모드", () => {
  it("켠 시각부터 정한 시간 동안만", () => {
    const n = startNight(1000, 8);
    expect(n.until).toBe(1000 + 8 * 3600_000);
    expect(nightActive(n, 1000 + 3600_000)).toBe(true);
    expect(nightActive(n, n.until)).toBe(false);
    expect(nightActive(undefined, 0)).toBe(false);
  });
  it("자동 승인: 배치·기타 확인만 — 기획 확인·합치기 대기·git 만들기는 아침까지", () => {
    expect(nightAutoApproves("allocation")).toBe(true);
    expect(nightAutoApproves("other")).toBe(true);
    expect(nightAutoApproves("plan")).toBe(false);
    expect(nightAutoApproves("merge")).toBe(false);
    expect(nightAutoApproves("git")).toBe(false);
  });
  it("같은 에이전트가 연달아 실패하면 멈춤, 한 번이라도 되면 다시 셈", () => {
    let f: Record<string, number> = {};
    let r = noteResult(f, "m1", false);
    for (let i = 1; i < NIGHT_FAILS; i++) r = noteResult(r.fails, "m1", false);
    expect(r.stop).toBe(true);
    f = noteResult(noteResult({}, "m1", false).fails, "m1", true).fails;
    expect(f.m1).toBe(0);
    expect(noteResult({ m2: 2 }, "m1", false).stop).toBe(false);
  });
});
