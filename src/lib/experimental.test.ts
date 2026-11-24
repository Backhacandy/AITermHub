// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { teamEnabled } from "./experimental";

describe("팀은 실험 기능", () => {
  it("꺼져 있고 열린 팀 탭이 없으면 숨긴다", () => {
    expect(teamEnabled({ experimentalTeam: false }, 0)).toBe(false);
  });
  it("이미 열린 팀 탭이 있으면 그대로 보인다(기존 프로젝트를 깨지 않음)", () => {
    expect(teamEnabled({ experimentalTeam: false }, 1)).toBe(true);
  });
  it("켜면 보인다", () => {
    expect(teamEnabled({ experimentalTeam: true }, 0)).toBe(true);
  });
});
