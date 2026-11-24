// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { fromClaudeEvent, fromCodexRateLimits, fmtReset, limitDelta, rejectResetS } from "./limits";

describe("fromClaudeEvent", () => {
  it("unifiedWindows의 5시간·주간 사용률(0~1)을 %로", () => {
    const ev = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 0.52, resetsAt: 1791976200 }, seven_day: { utilization: 0.18, resetsAt: 1792400000 } },
      },
    };
    expect(fromClaudeEvent(ev)).toEqual({
      fiveHour: { pct: 52, resetsAt: 1791976200_000 },
      weekly: { pct: 18, resetsAt: 1792400000_000 },
    });
  });
  it("unifiedWindows가 없으면 rateLimitType + utilization", () => {
    const ev = { type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day", utilization: 0.4, resetsAt: 100 } };
    expect(fromClaudeEvent(ev)).toEqual({ weekly: { pct: 40, resetsAt: 100_000 } });
  });
  it("정보가 없으면 null", () => {
    expect(fromClaudeEvent({ type: "rate_limit_event" })).toBeNull();
    expect(fromClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toBeNull();
  });
});

describe("fromCodexRateLimits", () => {
  it("window_minutes로 5시간/주간 구분", () => {
    const rl = {
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 2 },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: 3 },
    };
    expect(fromCodexRateLimits(rl)).toEqual({ fiveHour: { pct: 12.5, resetsAt: 2000 }, weekly: { pct: 3, resetsAt: 3000 } });
  });
  it("주간만 있는 계정", () => {
    expect(fromCodexRateLimits({ primary: { used_percent: 1, window_minutes: 10080, resets_at: 5 }, secondary: null })).toEqual({
      weekly: { pct: 1, resetsAt: 5000 },
    });
  });
  it("없으면 null", () => {
    expect(fromCodexRateLimits(null)).toBeNull();
    expect(fromCodexRateLimits({ primary: null })).toBeNull();
  });
});

describe("fmtReset", () => {
  const now = new Date(2026, 9, 14, 21, 0, 0).getTime(); // 수요일 21:00
  it("하루 안이면 남은 시간", () => {
    expect(fmtReset(now + (2 * 60 + 10) * 60_000, now)).toBe("2시간 10분 후 리셋");
    expect(fmtReset(now + 35 * 60_000, now)).toBe("35분 후 리셋");
    expect(fmtReset(now - 1000, now)).toBe("곧 리셋");
  });
  it("하루 넘으면 요일·시각", () => {
    expect(fmtReset(new Date(2026, 9, 16, 9, 0).getTime(), now)).toBe("금 09:00 리셋");
  });
  it("모르면 빈 문자열", () => {
    expect(fmtReset(null, now)).toBe("");
  });
});

describe("limitDelta", () => {
  it("같은 기간 안의 증가분", () => {
    expect(limitDelta({ pct: 50, resetsAt: 1 }, { pct: 52.34, resetsAt: 1 })).toBe(2.3);
  });
  it("기간이 바뀌었거나(리셋) 모르면 null", () => {
    expect(limitDelta({ pct: 50, resetsAt: 1 }, { pct: 3, resetsAt: 2 })).toBeNull();
    expect(limitDelta(undefined, { pct: 3, resetsAt: 2 })).toBeNull();
  });
});

describe("한도 거절 때 막아 둘 시각", () => {
  it("찬 창(사용률 100%)의 초기화 시각을 쓴다 — 대표 시각(주간)이 아니라", () => {
    const info = { status: "rejected", resetsAt: 9000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 3000 }, seven_day: { utilization: 0.97, resetsAt: 9000 } } };
    expect(rejectResetS(info)).toBe(3000);
  });
  it("둘 다 찼으면 늦게 풀리는 쪽", () => {
    const info = { resetsAt: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 3000 }, seven_day: { utilization: 1, resetsAt: 9000 } } };
    expect(rejectResetS(info)).toBe(9000);
  });
  it("어느 창이 찼는지 모르면 알려 준 시각, 그것도 없으면 null", () => {
    expect(rejectResetS({ resetsAt: 4000 })).toBe(4000);
    expect(rejectResetS({})).toBeNull();
  });
});
