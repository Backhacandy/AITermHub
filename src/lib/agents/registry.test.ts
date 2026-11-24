// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { CLI_AGENTS, launchArgs, agentById } from "./registry";

describe("CLI 에이전트 목록", () => {
  it("id가 겹치지 않고 명령·설치 안내가 있다", () => {
    expect(new Set(CLI_AGENTS.map((a) => a.id)).size).toBe(CLI_AGENTS.length);
    for (const a of CLI_AGENTS) expect(a.cmd && a.install && a.site).toBeTruthy();
  });
  it("전체 권한일 때만 확인 생략 인자를 붙인다", () => {
    const g = agentById("gemini")!;
    expect(launchArgs(g, false)).toEqual(["/k", "gemini"]);
    expect(launchArgs(g, true)).toEqual(["/k", "gemini", "--yolo"]);
  });
});
