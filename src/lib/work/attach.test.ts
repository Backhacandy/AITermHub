// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { attachText, insertText, isImagePath } from "./attach";

describe("attach", () => {
  it("이미지는 [이미지: 경로], 파일은 따옴표 경로", () => {
    expect(isImagePath("C:\a\shot.PNG")).toBe(true);
    expect(attachText(["C:\p\.aith\attach\shot-1.png", "C:\p\log.txt"])).toBe('[이미지: C:\p\.aith\attach\shot-1.png] "C:\p\log.txt"');
  });
  it("입력 뒤에 한 칸 띄워 붙인다", () => {
    expect(insertText("", "[이미지: a.png]")).toBe("[이미지: a.png] ");
    expect(insertText("이거 봐줘  ", "[이미지: a.png]")).toBe("이거 봐줘 [이미지: a.png] ");
    expect(insertText("x", "")).toBe("x");
  });
});
