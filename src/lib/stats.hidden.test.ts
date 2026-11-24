// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

describe("창이 숨겨진 동안", () => {
  it("출력이 와도 화면 틱을 깨우지 않는다(최소화 중 출력마다 다시 그리지 않게)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    (globalThis as { document?: unknown }).document = { hidden: true, addEventListener: () => {} };
    const { startStats, markOutput, nowTick } = await import("./stats.svelte");
    await startStats();
    const before = nowTick.t;
    vi.setSystemTime(1_005_000);
    markOutput("t1");
    expect(nowTick.t).toBe(before);
    vi.useRealTimers();
  });
});
