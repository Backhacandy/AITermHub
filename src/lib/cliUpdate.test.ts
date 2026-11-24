// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { cliUpdateDue, summarize, type CliUpdate } from "./cliUpdate";

describe("CLI 자동 업데이트", () => {
  const H = 3600_000;
  it("켜져 있고 하루가 지났고 일하는 에이전트가 없을 때만", () => {
    expect(cliUpdateDue(true, undefined, 0, false)).toBe(true);
    expect(cliUpdateDue(true, 0, 24 * H, false)).toBe(true);
    expect(cliUpdateDue(true, 0, 23 * H, false)).toBe(false);
    expect(cliUpdateDue(true, 0, 24 * H, true)).toBe(false);
    expect(cliUpdateDue(false, undefined, 0, false)).toBe(false);
    // 꺼 둔 적 없으면(설정 없음) 켜진 것으로 본다
    expect(cliUpdateDue(undefined, undefined, 0, false)).toBe(true);
  });
  it("결과 한 줄: 바뀐 것·실패만 알림 거리", () => {
    const up: CliUpdate[] = [
      { cli: "claude", before: "2.1.322", after: "2.1.330", ok: true, message: "2.1.322 → 2.1.330" },
      { cli: "codex", before: "0.167.0", after: "0.167.0", ok: true, message: "최신이에요(0.167.0)" },
    ];
    expect(summarize(up)).toEqual({ text: "Claude Code 2.1.322 → 2.1.330 · Codex 최신이에요(0.167.0)", notable: true });
    expect(summarize([up[1]]).notable).toBe(false);
    expect(summarize([{ cli: "codex", before: "0.1", after: "0.1", ok: false, message: "EACCES" }])).toEqual({ text: "Codex 실패: EACCES", notable: true });
  });
});
