// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { composeReview } from "./comments";

describe("composeReview", () => {
  it("파일·줄 순으로 정리하고 코드 조각을 붙인다", () => {
    const t = composeReview([
      { id: 1, file: "src/b.ts", line: 3, code: "  let x = `a`", text: "이름 바꿔" },
      { id: 2, file: "src/a.ts", line: 9, code: "", text: " 예외 처리 " },
      { id: 3, file: "src/a.ts", line: 2, code: "foo()", text: "" },
    ]);
    expect(t).toBe("아래 코드 리뷰 코멘트대로 고쳐줘.\n- src/a.ts:9 → 예외 처리\n- src/b.ts:3 `let x = 'a'` → 이름 바꿔");
  });
  it("코멘트가 없으면 빈 글", () => {
    expect(composeReview([])).toBe("");
  });
});
