// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { releaseDue, sleepDue } from "./idleRelease";

const MIN = 60_000;
describe("쉬는 Claude", () => {
  it("2분 쉬면 재운다(프로세스는 그대로라 캐시도 그대로), 꺼져 있으면 안 함", () => {
    expect(sleepDue(0, 2 * MIN - 1, {})).toBe(false);
    expect(sleepDue(0, 2 * MIN, {})).toBe(true);
    expect(sleepDue(0, 99 * MIN, { releaseIdle: false })).toBe(false);
  });
  it("완전히 끄는 건 기본 1시간, 캐시가 사는 1시간 안에는 끄지 않는다", () => {
    expect(releaseDue(0, 59 * MIN, {})).toBe(false);
    expect(releaseDue(0, 60 * MIN, {})).toBe(true);
    expect(releaseDue(0, 59 * MIN, { releaseMinutes: 15 })).toBe(false);
    expect(releaseDue(0, 90 * MIN, { releaseMinutes: 90 })).toBe(true);
    expect(releaseDue(0, 999 * MIN, { releaseIdle: false })).toBe(false);
  });
});

describe("백그라운드 작업(빌드 등)이 도는 동안", () => {
  it("재우지도 끄지도 않는다", () => {
    expect(sleepDue(0, 99 * MIN, {}, 1)).toBe(false);
    expect(releaseDue(0, 999 * MIN, {}, 2)).toBe(false);
    expect(sleepDue(0, 99 * MIN, {}, 0)).toBe(true);
  });
});
