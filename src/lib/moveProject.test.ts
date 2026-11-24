// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { rebase, retitle, planTeam, pathKey } from "./moveProject";
import type { Member } from "./team/team";

describe("프로젝트 경로 바꾸기", () => {
  it("옛 폴더 아래 경로를 새 폴더 아래로(대소문자·구분자 무시)", () => {
    expect(rebase("C:\\Game", "C:\\Game", "D:\\Work\\Game")).toBe("D:\\Work\\Game");
    expect(rebase("C:\\Game\\.aith/wt/t-a-m1", "c:/game/", "D:\\Work\\Game")).toBe("D:\\Work\\Game\\.aith\\wt\\t-a-m1");
    expect(rebase("C:\\Gamey\\x", "C:\\Game", "D:\\L")).toBeNull();
    expect(rebase("E:\\other", "C:\\Game", "D:\\L")).toBeNull();
  });

  it("제목 끝 폴더 이름만 바꾼다(직접 바꾼 제목은 그대로)", () => {
    expect(retitle("팀 · Game", "C:\\Game", "D:\\Work\\GameTwo")).toBe("팀 · GameTwo");
    expect(retitle("게임투 팀", "C:\\Game", "D:\\Work\\GameTwo")).toBe("게임투 팀");
  });

  it("팀 에이전트 작업 폴더도 새 경로로(프로젝트 밖은 그대로)", () => {
    const team = [
      { id: "lead", name: "팀장", cli: "claude", lead: true, chat: "t1" },
      { id: "m1", name: "UI", cli: "claude", resume: "s1", wt: "C:\\Game\\.aith\\wt\\t-t1-m1" },
      { id: "m2", name: "QA", cli: "codex", wt: "E:\\elsewhere" },
      { id: "m3", name: "기획", cli: "claude" },
    ] as unknown as Member[];
    const p = planTeam(team, "C:\\Game", "D:\\Game");
    expect(p.worktrees).toEqual([["C:\\Game\\.aith\\wt\\t-t1-m1", "D:\\Game\\.aith\\wt\\t-t1-m1"]]);
    expect(p.team?.[1]).toMatchObject({ wt: "D:\\Game\\.aith\\wt\\t-t1-m1", resume: "s1" });
    expect(p.team?.[2].wt).toBe("E:\\elsewhere");
    expect(p.team?.[3].wt).toBeUndefined();
    // 원래 구성은 건드리지 않는다
    expect(team[1].wt).toBe("C:\\Game\\.aith\\wt\\t-t1-m1");
    expect(planTeam(undefined, "a", "b")).toEqual({ worktrees: [] });
  });

  it("경로 키", () => {
    expect(pathKey("C:\\Game\\")).toBe(pathKey("c:/game"));
  });
});
