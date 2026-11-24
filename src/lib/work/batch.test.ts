// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
import { batcher } from "./batch";

describe("스트림 이벤트 모아 처리", () => {
  it("간격 안에 온 것은 한 번에 순서대로", () => {
    vi.useFakeTimers();
    const got: number[][] = [];
    let cur: number[] = [];
    const b = batcher<number>((x) => cur.push(x), 80, () => { got.push(cur); cur = []; });
    b.push(1); b.push(2); b.push(3);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(80);
    expect(got).toEqual([[1, 2, 3]]);
    b.push(4);
    vi.advanceTimersByTime(80);
    expect(got).toEqual([[1, 2, 3], [4]]);
    vi.useRealTimers();
  });
  it("flush는 남은 것을 바로 처리(종료 이벤트 전에)", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const b = batcher<number>((x) => seen.push(x), 80);
    b.push(1); b.push(2);
    b.flush();
    expect(seen).toEqual([1, 2]);
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([1, 2]);
    vi.useRealTimers();
  });
  it("하나가 실패해도 나머지는 처리", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const b = batcher<number>((x) => { if (x === 2) throw new Error("x"); seen.push(x); }, 10);
    b.push(1); b.push(2); b.push(3);
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([1, 3]);
    vi.useRealTimers();
  });
});
