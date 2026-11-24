// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { tabState } from "./tabState";

describe("세션 상태", () => {
  it("일하는 중이면 무엇이든 작업중", () => {
    expect(tabState("pair", true, undefined)).toBe("busy");
    expect(tabState("term", true, { suspended: true })).toBe("busy");
  });
  it("Claude·협업은 재웠거나 꺼졌으면 수면, 깨어 있으면 유휴", () => {
    expect(tabState("pair", false, { suspended: true })).toBe("sleep");
    expect(tabState("claude", false, undefined)).toBe("sleep");
    expect(tabState("claude", false, { suspended: false })).toBe("idle");
  });
  it("터미널은 일시정지면 수면, Codex는 지시 사이 프로세스 없음이 정상(유휴)", () => {
    expect(tabState("term", false, { suspended: true })).toBe("sleep");
    expect(tabState("codex", false, undefined)).toBe("idle");
  });
});

import { teamMain } from "./tabState";
describe("팀 탭 수면 판단", () => {
  it("Claude 에이전트가 하나라도 깨어 있으면 깨어 있음, 모두 재움·꺼짐이면 수면", () => {
    expect(teamMain([{ suspended: true }, { suspended: false }])).toEqual({ suspended: false });
    expect(teamMain([{ suspended: true }, { suspended: true }])).toEqual({ suspended: true });
    expect(teamMain([])).toBeUndefined();
  });
});

describe("백그라운드 작업만 남은 탭", () => {
  it("답은 끝났고 백그라운드 작업만 돌면 작업중이 아니라 백그라운드", () => {
    expect(tabState("claude", false, { suspended: false }, true)).toBe("bg");
    expect(tabState("pair", false, undefined, true)).toBe("bg");
    // 일하는 중이면 그대로 작업중
    expect(tabState("claude", true, { suspended: false }, true)).toBe("busy");
  });
});
