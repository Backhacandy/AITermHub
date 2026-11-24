// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { classifyCodexStderr } from "./codexLog";

describe("Codex 내부 로그 표시", () => {
  it("패치 형식 오류는 따로 묶는다", () => {
    expect(classifyCodexStderr("2026-10-24T02:30:03.589525Z ERROR codex_core::tools::router: error=apply_patch verification failed: invalid patch: multiple operations target C:\a\B.kt")).toEqual({ kind: "patch" });
  });
  it("그 밖의 내부 로그는 흐린 안내로(시각·모듈 이름 빼고)", () => {
    expect(classifyCodexStderr("2026-10-24T02:30:03.5Z WARN codex_core::exec: command timed out")).toEqual({ kind: "note", text: "command timed out" });
    expect(classifyCodexStderr("2026-10-24T02:30:03Z ERROR codex_core::tools::router: error=exec failed: no such file")).toEqual({ kind: "note", text: "exec failed: no such file" });
  });
  it("stdin 안내·빈 줄은 숨기고, 내부 로그가 아닌 건 오류 그대로", () => {
    expect(classifyCodexStderr("Reading prompt from stdin...")).toEqual({ kind: "skip" });
    expect(classifyCodexStderr("   ")).toEqual({ kind: "skip" });
    expect(classifyCodexStderr("Error: You've hit your usage limit")).toEqual({ kind: "error", text: "Error: You've hit your usage limit" });
  });
});
