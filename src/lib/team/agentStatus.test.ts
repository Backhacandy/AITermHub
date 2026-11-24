// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { agentState, activityLine, lastHandoff, STATE_LABEL } from "./agentStatus";
import type { LogEntry } from "$lib/work/types";

const tool = (verb: LogEntry["verb"], text: string): LogEntry => ({ key: text, kind: "tool", verb, text });

describe("에이전트 카드 상태", () => {
  it("준비·오류·작업·차례 기다림·쉬는 중", () => {
    expect(agentState({ ready: false, working: true, queued: false, error: false })).toBe("prep");
    expect(agentState({ ready: true, working: false, queued: false, error: true })).toBe("error");
    expect(agentState({ ready: true, working: true, queued: true, error: false })).toBe("work");
    expect(agentState({ ready: true, working: false, queued: true, error: false })).toBe("wait");
    expect(agentState({ ready: true, working: false, queued: false, error: false })).toBe("rest");
    expect(STATE_LABEL.wait).toBe("차례 기다림");
  });

  it("지금 하는 일 한 줄: 마지막 도구, 경로는 파일 이름만, 길면 줄임", () => {
    expect(activityLine([tool("read", "Docs/GDD.md"), tool("edit", "Assets\\Scripts\\UI\\StartScene.cs")], true)).toBe("고치는 중 · StartScene.cs");
    expect(activityLine([tool("run", "npm test")], true)).toBe("실행 중 · npm test");
    expect(activityLine([tool("read", "a/b.md")], true)).toBe("읽는 중 · b.md");
    expect(activityLine([tool("other", "WebSearch")], true)).toBe("WebSearch");
    expect(activityLine([{ key: "u", kind: "user", text: "해줘" }], true)).toBe("생각 중");
    expect(activityLine([tool("edit", "x.cs")], false)).toBe("");
    expect(activityLine([tool("run", "x".repeat(100))], true).length).toBeLessThanOrEqual(70);
  });

  it("마지막 인계", () => {
    expect(lastHandoff("한 일\n### 인계\n- Main.unity 추가\n- 요청: @QA 확인\n### 다음 단계\n빌드")).toBe("- Main.unity 추가\n- 요청: @QA 확인");
    expect(lastHandoff("### 인계\n없음")).toBe("없음");
    expect(lastHandoff("인계 없이 끝")).toBe("");
  });
});

describe("오류보다 일하는 중이 먼저", () => {
  it("일하는 중에 경고 한 줄이 와도 작업 중", () => {
    expect(agentState({ ready: true, working: true, queued: false, error: true })).toBe("work");
    expect(agentState({ ready: true, working: false, queued: false, error: true })).toBe("error");
  });
});

describe("백그라운드 작업", () => {
  it("답은 끝냈지만 빌드·테스트가 돌면 쉬는 중이 아니라 백그라운드 작업 중", () => {
    expect(agentState({ ready: true, working: false, queued: false, error: false, bg: true })).toBe("bg");
    expect(agentState({ ready: true, working: true, queued: false, error: false, bg: true })).toBe("work");
    expect(agentState({ ready: true, working: false, queued: false, error: false, bg: false })).toBe("rest");
    expect(STATE_LABEL.bg).toMatch(/백그라운드/);
  });
});
