// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { teamDraft } from "./draft";

describe("새 팀 구성", () => {
  it("에이전트를 안 넣으면 팀장 하나 — 운영 방식의 팀장 모델·생각으로", () => {
    const t = teamDraft([], "lite", { front: [], back: [] });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: "lead", lead: true, mode: "lite", model: "sonnet", effort: "medium" });
    expect(teamDraft([], "max", { front: [], back: [] })[0]).toMatchObject({ mode: "max", model: "opus", effort: "high" });
  });
  it("직접 넣은 에이전트는 팀장 뒤에", () => {
    const t = teamDraft([
      { name: "UI", cli: "claude", model: "auto", purpose: "화면", areas: [] },
      { name: "", cli: "codex", model: "auto", purpose: "", areas: [] },
    ], "max", { front: [], back: [] });
    expect(t.map((m) => m.lead ? "팀장" : m.cli)).toEqual(["팀장", "claude", "codex"]);
    expect(new Set(t.map((m) => m.id)).size).toBe(3);
  });
  it("라이트면 직접 넣은 에이전트 모델도 등급 3 이하(자동 포함)", () => {
    const t = teamDraft([{ name: "A", cli: "claude", model: "opus", purpose: "", areas: [] }, { name: "B", cli: "codex", model: "auto", purpose: "", areas: [] }], "lite", { front: [], back: [] });
    expect(t.slice(1).map((m) => m.model)).toEqual(["sonnet", "gpt-6.2-sol"]);
  });
});
