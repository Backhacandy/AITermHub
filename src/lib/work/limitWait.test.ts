// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { waitMs, LIMIT_RETRY_MS } from "./limitWait";

describe("한도가 풀릴 때까지 기다리는 시간", () => {
  it("풀리는 시각 1분 뒤까지(서버 시계가 조금 늦어도 되게)", () => {
    expect(waitMs(1_000_000 + 600_000, 1_000_000)).toBe(660_000);
  });
  it("이미 지났거나 곧이면 1분", () => {
    expect(waitMs(1_000_000 - 5_000, 1_000_000)).toBe(60_000);
  });
  it("모르면 30분마다 다시 본다", () => {
    expect(waitMs(null, 1_000_000)).toBe(LIMIT_RETRY_MS);
    expect(LIMIT_RETRY_MS).toBe(30 * 60_000);
  });
});
