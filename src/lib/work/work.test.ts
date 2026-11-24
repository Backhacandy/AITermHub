// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { createWork } from "./work.svelte";

describe("createWork", () => {
  it("AI 텍스트 스트리밍은 같은 key에 이어 붙는다", () => {
    const w = createWork();
    w.aiAppend("t1", "안녕");
    w.aiAppend("t1", "하세요");
    expect(w.log.map((e) => e.text)).toEqual(["안녕하세요"]);
    w.aiSet("t1", "최종");
    expect(w.log[0].text).toBe("최종");
  });
  it("빈 aiSet은 무시", () => {
    const w = createWork();
    w.aiSet("x", "  ");
    expect(w.log.length).toBe(0);
  });
  it("touch는 라이브 대상을 바꾸고 shown은 따라가기/선택을 따른다", () => {
    const w = createWork();
    w.touch({ key: "a", kind: "edit", label: "a" });
    w.touch({ key: "b", kind: "edit", label: "b" });
    expect(w.shown?.key).toBe("b");
    w.select("a");
    expect(w.shown?.key).toBe("a");
    w.touch({ key: "c", kind: "edit", label: "c" });
    expect(w.shown?.key).toBe("a"); // 선택 중엔 고정
    w.resumeLive();
    expect(w.shown?.key).toBe("c");
  });
  it("live=false면 라이브 대상을 바꾸지 않는다", () => {
    const w = createWork();
    w.touch({ key: "a", kind: "edit", label: "a" });
    w.touch({ key: "r", kind: "read", label: "r" }, undefined, false);
    expect(w.ui.live).toBe("a");
  });
  it("settle은 origin 기준으로 +/−를 계산", () => {
    const w = createWork();
    w.touch({ key: "a", kind: "edit", label: "a" }, (f) => {
      f.origin = "a\nb";
      f.writing = true;
    });
    const f = w.settle("a", "a\nB\nc", "done", true)!;
    expect(f).toMatchObject({ added: 2, removed: 1, writing: false, status: "done" });
    expect(f.settledAt).toBeTypeOf("number");
  });
  it("failRunning은 실행 중 도구·작성 중 파일을 오류로", () => {
    const w = createWork();
    w.tool("t", "edit", "a", "running");
    w.touch({ key: "a", kind: "edit", label: "a" }, (f) => (f.writing = true));
    w.ui.status = "작성 중";
    w.failRunning();
    expect(w.log[0].status).toBe("error");
    expect(w.files[0]).toMatchObject({ writing: false, status: "error" });
    expect(w.ui.status).toBe("");
  });
});
