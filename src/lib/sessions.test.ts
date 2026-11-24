// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { continueArgs } from "./sessions.svelte";

describe("continueArgs — 복원 시 터미널 탭을 '이어서'로", () => {
  it("claude: -c를 붙이고 세션 선택(-r)은 최근 대화로 바꾼다", () => {
    expect(continueArgs("claude", ["/k", "claude"])).toEqual(["/k", "claude", "-c"]);
    expect(continueArgs("claude", ["/k", "claude", "-r", "--model", "opus"])).toEqual(["/k", "claude", "-c", "--model", "opus"]);
    expect(continueArgs("claude", ["/k", "claude", "-c"])).toEqual(["/k", "claude", "-c"]);
  });
  it("codex: resume --last", () => {
    expect(continueArgs("codex", ["/k", "codex", "-m", "x"])).toEqual(["/k", "codex", "resume", "--last", "-m", "x"]);
    expect(continueArgs("codex", ["/k", "codex", "resume", "--last", "-m", "x"])).toEqual(["/k", "codex", "resume", "--last", "-m", "x"]);
    expect(continueArgs("codex", ["/k", "codex", "resume"])).toEqual(["/k", "codex", "resume", "--last"]);
  });
  it("PowerShell 등은 그대로", () => {
    expect(continueArgs("powershell", [])).toEqual([]);
  });
});

import { tabs, addClaude, addTab, toTeam } from "./sessions.svelte";
describe("단일 탭 → 팀 탭", () => {
  it("지금 대화·모델을 첫 에이전트로, 원래 탭은 닫고 추가 창을 연다", () => {
    const cid = addClaude("C:\p", "opus");
    tabs.find((t) => t.id === cid)!.resume = "S";
    const nid = toTeam(cid)!;
    const nt = tabs.find((t) => t.id === nid)!;
    expect(nt.kind).toBe("pair");
    expect(nt.cwd).toBe("C:\p");
    // 기본 운영 방식(라이트)의 팀장이 맨 앞, 지금 모델은 라이트 등급으로 낮추고 원래 모델을 기억(맥스로 바꾸면 되돌린다)
    expect(nt.team?.[0]).toMatchObject({ id: "lead", lead: true, mode: "lite", model: "sonnet" });
    expect(nt.team?.[1]).toEqual({ id: "m1", name: "Claude", cli: "claude", model: "sonnet", maxModel: "opus", purpose: "", areas: [], resume: "S" });
    expect(nt.addOpen).toBe(true);
    expect(tabs.some((t) => t.id === cid)).toBe(false);
  });
  it("터미널 탭은 못 바꾼다", () => {
    expect(toTeam(addTab("powershell"))).toBeNull();
  });
});

import { renamedTitle } from "./sessions.svelte";
describe("예전 이름 탭 → 지금 이름(팀 / 자동 진행)", () => {
  it("협업 탭은 '팀 · 폴더', AI 회사 탭은 '자동 진행', 직접 바꾼 이름은 그대로", () => {
    expect(renamedTitle({ kind: "pair", title: "🤝 협업", cwd: "C:\\MyGame" })).toBe("팀 · MyGame");
    expect(renamedTitle({ kind: "pair", title: "협업 · MonsterGame", cwd: "C:\\MonsterGame" })).toBe("팀 · MonsterGame");
    expect(renamedTitle({ kind: "company", title: "AI 회사" })).toBe("자동 진행");
    expect(renamedTitle({ kind: "pair", title: "팀 · MonsterGame", cwd: "C:\\MonsterGame" })).toBe("팀 · MonsterGame");
    expect(renamedTitle({ kind: "pair", title: "결제 작업", cwd: "C:\\x" })).toBe("결제 작업");
    expect(renamedTitle({ kind: "claude", title: "Claude · x" })).toBe("Claude · x");
  });
});

import * as sessionsMod from "./sessions.svelte";
describe("로컬 에이전트(Ollama) 지원 종료", () => {
  it("옛 로컬 에이전트 탭은 복원돼도 그대로 두고(안내 화면용), 새로 만드는 함수는 없다", () => {
    expect("addAgent" in sessionsMod).toBe(false);
    const store: Record<string, string> = { "aith.tabs": JSON.stringify({ tabs: [{ kind: "agent", title: "에이전트", preset: "agent", program: "", args: [] }], active: 0 }) };
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) };
    tabs.splice(0, tabs.length);
    expect(sessionsMod.restoreTabs()).toBe(true);
    expect(tabs.map((t) => t.kind)).toEqual(["agent"]);
  });
});

describe("자동 진행(별도 창) 지원 종료", () => {
  it("옛 자동 진행 탭은 복원돼도 그대로 두고(안내 화면용), 새로 여는 함수는 없다", () => {
    expect("addCompany" in sessionsMod).toBe(false);
    const store: Record<string, string> = { "aith.tabs": JSON.stringify({ tabs: [{ kind: "company", title: "자동 진행", preset: "claude", program: "", args: [] }], active: 0 }) };
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) };
    tabs.splice(0, tabs.length);
    expect(sessionsMod.restoreTabs()).toBe(true);
    expect(tabs.map((t) => t.kind)).toEqual(["company"]);
  });
});

import { rememberClosed, closedTeams, reopenTeam } from "./sessions.svelte";
describe("최근 닫은 팀", () => {
  const team = (chat: string, title = "팀 · Luck") => ({ title, preset: "claude" as const, program: "", args: [], kind: "pair" as const, cwd: "C:/Luck", team: [{ id: "lead", name: "팀장", cli: "claude" as const, model: "opus", purpose: "", areas: [], lead: true, chat }, { id: "m1", name: "UI", cli: "claude" as const, model: "sonnet", purpose: "화면", areas: [], resume: "s1" }] });
  it("팀 탭만, 같은 팀은 하나로(최근 것이 앞), 10개까지", () => {
    let l = rememberClosed([], team("a"), 1);
    l = rememberClosed(l, { title: "PowerShell", preset: "powershell", program: "powershell.exe", args: [], kind: "term" }, 2);
    expect(l).toHaveLength(1);
    l = rememberClosed(l, team("a", "팀 · Luck 2"), 3);
    expect(l).toHaveLength(1);
    expect(l[0].tab.title).toBe("팀 · Luck 2");
    for (let i = 0; i < 12; i++) l = rememberClosed(l, team(`t${i}`), 10 + i);
    expect(l).toHaveLength(10);
    expect(l[0].tab.team?.[0].chat).toBe("t11");
  });
  it("닫으면 저장되고, 다시 열면 같은 구성·대화로 탭이 생기고 목록에서 빠진다", () => {
    const store: Record<string, string> = {};
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) };
    tabs.splice(0, tabs.length);
    const id = addTab("powershell");
    const tid = sessionsMod.addSession(team("z"));
    sessionsMod.closeTab(tid);
    sessionsMod.closeTab(id);
    expect(closedTeams().map((c) => c.tab.team?.[1].resume)).toEqual(["s1"]);
    const nid = reopenTeam(0);
    const t = tabs.find((x) => x.id === nid)!;
    expect(t.kind).toBe("pair");
    expect(t.team?.[0].chat).toBe("z");
    expect(closedTeams()).toEqual([]);
  });
});
