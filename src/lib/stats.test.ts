// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { isBusy, markOutput, setWorking } from "./stats.svelte";

describe("작업중 판정", () => {
  it("구조화 탭은 뷰가 알려준 진행 상태로", () => {
    expect(isBusy("cl1")).toBe(false);
    setWorking("cl1", true);
    expect(isBusy("cl1")).toBe(true);
    setWorking("cl1", false);
    expect(isBusy("cl1")).toBe(false);
  });
  it("터미널 탭은 최근 출력으로(그대로)", () => {
    markOutput("t1");
    expect(isBusy("t1")).toBe(true);
  });
});

import { tickDelay } from "./stats.svelte";
describe("화면 틱 간격", () => {
  it("일하는 세션이 있고 창이 보일 때만 빠르게", () => {
    expect(tickDelay(10_000, { a: 9_000 }, false)).toBe(800);
    expect(tickDelay(10_000, { a: 6_000 }, false)).toBe(30_000);
    expect(tickDelay(10_000, { a: 9_000 }, true)).toBe(30_000);
    expect(tickDelay(10_000, {}, false)).toBe(30_000);
  });
});
