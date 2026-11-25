// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { CLI_AGENTS, ALL_AIS, launchArgs, agentById } from "./registry";

describe("CLI 에이전트 목록", () => {
  it("id가 겹치지 않고 명령·설치 안내가 있다", () => {
    expect(new Set(CLI_AGENTS.map((a) => a.id)).size).toBe(CLI_AGENTS.length);
    for (const a of CLI_AGENTS) expect(a.cmd && a.install && a.site).toBeTruthy();
  });
  it("AI 추가 목록에는 Claude Code·Codex가 맨 앞에, 다른 AI가 모두 이어서 있다", () => {
    expect(ALL_AIS.slice(0, 2).map((a) => a.id)).toEqual(["claude", "codex"]);
    for (const a of CLI_AGENTS) expect(ALL_AIS.map((x) => x.id)).toContain(a.id);
    expect(new Set(ALL_AIS.map((a) => a.id)).size).toBe(ALL_AIS.length);
    for (const a of ALL_AIS) expect(a.cmd && a.install && a.site).toBeTruthy();
    // Claude·Codex는 구조화 탭으로 열고, 로그인 명령이 있다
    for (const id of ["claude", "codex"]) {
      const a = ALL_AIS.find((x) => x.id === id)!;
      expect(a.structured).toBe(true);
      expect(a.loginCmd).toBeTruthy();
    }
  });
  it("전체 권한일 때만 확인 생략 인자를 붙인다", () => {
    const g = agentById("gemini")!;
    expect(launchArgs(g, false)).toEqual(["/k", "gemini"]);
    expect(launchArgs(g, true)).toEqual(["/k", "gemini", "--yolo"]);
  });
});
