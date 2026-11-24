// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { stuckCheck, toolLimitMs, unstuckPrompt, GRACE_MS, QUIET_MS, type OpenTool } from "./stuck";

const MIN = 60_000;
const bash = (at: number, input: Record<string, unknown> = {}): OpenTool => ({ id: "t1", name: "Bash", input: { command: "node verify.mjs out/a.webm", ...input }, at });

describe("멈춘 명령", () => {
  it("Bash 제한 시간: 기본 2분, 최대 10분, 백그라운드는 바로 돌아옴", () => {
    expect(toolLimitMs({ name: "Bash", input: {} })).toBe(2 * MIN);
    expect(toolLimitMs({ name: "Bash", input: { timeout: 500_000 } })).toBe(500_000);
    expect(toolLimitMs({ name: "Bash", input: { timeout: 900_000 } })).toBe(10 * MIN);
    expect(toolLimitMs({ name: "Bash", input: { run_in_background: true } })).toBe(30_000);
    expect(toolLimitMs({ name: "Agent", input: {} })).toBeNull();
  });

  // 11/17 MyDocs m3: 8분 20초 제한 명령이 3시간 24분 동안 끝나지 않았다
  it("제한 + 여유를 넘기고 출력도 없으면 푼다", () => {
    const t = bash(0, { timeout: 500_000 });
    const due = 500_000 + GRACE_MS;
    expect(stuckCheck([t], 0, due - 1000, true).unstick).toBeNull();
    const v = stuckCheck([t], 0, due + 1000, true);
    expect(v.unstick?.id).toBe("t1");
    expect(v.quietMin).toBeGreaterThan(0);
  });

  it("제한 안에서 오래 걸리는 명령(빌드 등)은 그대로 둔다", () => {
    const t = bash(0, { timeout: 600_000 });
    expect(stuckCheck([t], 0, 9 * MIN, true)).toEqual({ unstick: null, quietMin: 0 });
  });

  it("최근에 출력이 있었으면 풀지 않는다(진행 중)", () => {
    const t = bash(0, { timeout: 120_000 });
    expect(stuckCheck([t], 20 * MIN, 21 * MIN, true).unstick).toBeNull();
  });

  it("차례가 안 돌면(쉬는 중) 아무것도 안 한다", () => {
    expect(stuckCheck([bash(0)], 0, 99 * MIN, false)).toEqual({ unstick: null, quietMin: 0 });
  });

  it("서브에이전트처럼 끝날 때를 모르는 도구는 풀지 않고, 아주 오래 조용하면 보이게만", () => {
    const sub: OpenTool = { id: "a", name: "Agent", input: {}, at: 0 };
    expect(stuckCheck([sub], 0, 20 * MIN, true)).toEqual({ unstick: null, quietMin: 0 });
    const v = stuckCheck([sub], 0, 2 * QUIET_MS + MIN, true);
    expect(v.unstick).toBeNull();
    expect(v.quietMin).toBe(31);
  });

  it("도구 없이 오래 조용하면(모델 응답이 안 옴) 보이게", () => {
    expect(stuckCheck([], 0, QUIET_MS - MIN, true).quietMin).toBe(0);
    expect(stuckCheck([], 0, QUIET_MS + MIN, true).quietMin).toBe(16);
  });

  it("이어서 하라는 말에 명령과 분이 들어간다", () => {
    const p = unstuckPrompt(bash(0), 24);
    expect(p).toContain("24분째");
    expect(p).toContain("node verify.mjs");
    expect(p).toContain("끊긴 지점부터");
  });
});
