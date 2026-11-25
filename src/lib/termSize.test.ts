// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { sizeUsable, dimsUsable } from "./termSize";

describe("터미널 크기를 CLI에 보낼지", () => {
  it("숨겨진 탭(크기 0)이나 아주 작은 칸은 보내지 않는다", () => {
    expect(sizeUsable(0, 0)).toBe(false);
    expect(sizeUsable(90, 600)).toBe(false);
    expect(dimsUsable(10, 30)).toBe(false);
    expect(dimsUsable(120, 3)).toBe(false);
  });
  it("보통 크기는 보낸다", () => {
    expect(sizeUsable(900, 500)).toBe(true);
    expect(dimsUsable(80, 24)).toBe(true);
  });
});
