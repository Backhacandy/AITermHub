// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { resumeTurns, flightEmpty, FLIGHT_TTL, type Flight } from "./flight";
import { leadPrompt } from "./leadAgent";
import type { Member } from "./team";

const M = (id: string, name: string, extra: Partial<Member> = {}): Member => ({ id, name, cli: "claude", model: "sonnet", purpose: "", areas: [], ...extra });
const team = [M("lead", "팀장", { lead: true, resume: "L" }), M("m1", "UI", { resume: "s1" }), M("m2", "QA", { cli: "codex", resume: "t2" }), M("m3", "기획")];
const now = 1_000_000_000;
const base: Flight = { at: now - 60_000, text: "화면 고쳐", results: [], running: [] };

describe("앱이 다시 켜졌을 때 하던 일 이어 하기", () => {
  it("끊긴 에이전트·못 간 결과·시작 못 한 에이전트를 한 차례로 팀장에게", () => {
    const t = resumeTurns({ ...base, results: [{ sid: "t2", answer: "### 인계\n- 고칠 것 12건" }], running: [{ id: "m1" }, { sid: "t2" }], pending: ["m3"] }, team, now);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "results", text: "화면 고쳐", results: [{ name: "QA", answer: "### 인계\n- 고칠 것 12건" }], restart: { cut: ["UI"], notStarted: ["기획"] } });
    const p = leadPrompt({ turn: t[0], members: team, status: {}, notes: [], full: false, cap: 8 });
    expect(p).toContain("[앱 재시작]");
    expect(p).toContain("중간에 끊긴 에이전트(결과 없음): UI");
    expect(p).toContain("끊긴 지점부터");
    expect(p).toContain("시작하지 못한 에이전트: 기획");
    expect(p).toContain("고칠 것 12건");
  });

  it("팀장이 답하던 차례와 기다리던 차례를 먼저 다시 보낸다", () => {
    const lead = { kind: "user" as const, text: "됐어?" };
    const q = { kind: "merge" as const, text: "합침" };
    expect(resumeTurns({ ...base, lead, queue: [q] }, team, now)).toEqual([lead, q]);
  });

  it("하루 지난 것·모르는 에이전트·하던 일이 없으면 아무것도 안 보낸다", () => {
    expect(resumeTurns({ ...base, at: now - FLIGHT_TTL - 1, running: [{ id: "m1" }] }, team, now)).toEqual([]);
    expect(resumeTurns({ ...base, running: [{ sid: "없음" }, { id: "lead" }] }, team, now)).toEqual([]);
    expect(resumeTurns(null, team, now)).toEqual([]);
    expect(flightEmpty(base)).toBe(true);
    expect(flightEmpty({ ...base, pending: ["m3"] })).toBe(false);
  });
});
