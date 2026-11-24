// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { lineDiff } from "./diff";

describe("lineDiff", () => {
  it("같으면 변경 없음", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual({ added: 0, removed: 0, changed: [] });
  });
  it("빈 내용에서 새로 쓰면 전부 추가", () => {
    expect(lineDiff("", "a\nb")).toEqual({ added: 2, removed: 0, changed: [0, 1] });
  });
  it("가운데 한 줄 변경", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1, changed: [1] });
  });
  it("떨어진 두 곳 삽입", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nX\nb\nc\nY\nd")).toEqual({ added: 2, removed: 0, changed: [1, 4] });
  });
  it("CRLF와 LF는 같은 내용", () => {
    expect(lineDiff("a\r\nb", "a\nb")).toEqual({ added: 0, removed: 0, changed: [] });
  });
  it("너무 크면 가운데 전체를 변경으로 근사", () => {
    const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join("\n");
    const d = lineDiff(a, b);
    expect(d.added).toBe(2000);
    expect(d.removed).toBe(2000);
    expect(d.changed.length).toBe(2000);
  });
});
