// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { addSession, tabs } from "$lib/sessions.svelte";
import { plainTeam } from "./clone.svelte";

describe("저장된 팀 불러오기", () => {
  it("탭에 저장된 에이전트 구성(반응형 값)을 평범한 값으로 복사", () => {
    const id = addSession({ title: "팀", preset: "claude", program: "", args: [], kind: "pair", team: [{ id: "m1", name: "Claude", cli: "claude", model: "auto", purpose: "", areas: ["web/**"] }] });
    const saved = tabs.find((t) => t.id === id)!.team!;
    const c = plainTeam(saved);
    expect(c).not.toBe(saved);
    expect(c).toEqual([{ id: "m1", name: "Claude", cli: "claude", model: "auto", purpose: "", areas: ["web/**"] }]);
  });
});
