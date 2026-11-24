// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { createWork } from "./work.svelte";
import { applyFsChanges } from "./fsChanges";
import type { WorkIO } from "./types";

const txt = (text: string) => ({ text, binary: false, encoding: "utf-8", size: text.length });

function io(disk: Record<string, string>, head: Record<string, string> = {}): WorkIO {
  return { read: async (p) => (p in disk ? txt(disk[p]) : null), baseline: async (p) => head[p] ?? null };
}

describe("applyFsChanges", () => {
  it("git 추적 파일은 HEAD를 기준으로 +/−와 강조", async () => {
    const w = createWork();
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "modify" }], io({ "C:\\p\\a.txt": "x\nY" }, { "C:\\p\\a.txt": "x\ny" }), "t1");
    const f = w.files[0];
    expect(f).toMatchObject({ key: "c:/p/a.txt", label: "a.txt", content: "x\nY", prev: "x\ny", added: 1, removed: 1 });
    expect(w.log[0]).toMatchObject({ kind: "tool", verb: "edit", text: "a.txt", meta: "+1 −1", fileKey: "c:/p/a.txt" });
  });
  it("새로 만든 파일은 전부 추가", async () => {
    const w = createWork();
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\n.txt", kind: "create" }], io({ "C:\\p\\n.txt": "1\n2" }));
    expect(w.files[0]).toMatchObject({ prev: "", added: 2, removed: 0 });
  });
  it("미추적 기존 파일은 이전 내용 없음", async () => {
    const w = createWork();
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\u.txt", kind: "modify" }], io({ "C:\\p\\u.txt": "z" }));
    expect(w.files[0]).toMatchObject({ prev: null, note: "이전 내용 없음", content: "z" });
  });
  it("두 번째 변경은 직전 내용을 강조 기준으로", async () => {
    const w = createWork();
    const disk = { "C:\\p\\a.txt": "1" };
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "create" }], io(disk));
    disk["C:\\p\\a.txt"] = "1\n2";
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "modify" }], io(disk));
    expect(w.files[0]).toMatchObject({ prev: "1", content: "1\n2", added: 2 });
  });
  it("도구가 작성 중이거나 방금 확정한 파일은 건너뛴다", async () => {
    const w = createWork();
    w.touch({ key: "c:/p/a.txt", kind: "edit", label: "a.txt" }, (f) => (f.writing = true));
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "modify" }], io({ "C:\\p\\a.txt": "NEW" }));
    expect(w.files[0].content).toBe("");
    w.settle("c:/p/a.txt", "OLD", "done", true);
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "modify" }], io({ "C:\\p\\a.txt": "NEW" }));
    expect(w.files[0].content).toBe("OLD");
  });
  it("바이너리 파일은 내용 대신 바이너리로 표시하고 +/−를 세지 않는다", async () => {
    const w = createWork();
    const bin: WorkIO = { read: async () => ({ text: "", binary: true, encoding: "binary", size: 2048 }), baseline: async () => null };
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\shot.png", kind: "create" }], bin, "t");
    expect(w.files[0]).toMatchObject({ binary: true, content: "", size: 2048, added: 0, removed: 0 });
    expect(w.log[0].meta).toBe("바이너리");
  });
  it("CP949 등 인코딩 정보를 남긴다", async () => {
    const w = createWork();
    const cp: WorkIO = { read: async () => ({ text: "한글", binary: false, encoding: "cp949", size: 4 }), baseline: async () => null };
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\k.txt", kind: "create" }], cp);
    expect(w.files[0]).toMatchObject({ content: "한글", encoding: "cp949", binary: false });
  });
  it("처음 보는 파일의 삭제는 무시, 아는 파일 삭제는 표시", async () => {
    const w = createWork();
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\tmp~", kind: "remove" }], io({}));
    expect(w.files.length).toBe(0);
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "create" }], io({ "C:\\p\\a.txt": "1" }));
    await applyFsChanges(w, "C:\\p", [{ path: "C:\\p\\a.txt", kind: "remove" }], io({}));
    expect(w.files[0]).toMatchObject({ content: "", note: "삭제됨" });
  });
});

import { BULK } from "./fsChanges";
import { createWork as cw2 } from "./work.svelte";
describe("한꺼번에 많이 바뀌면(빌드 산출물)", () => {
  it("git·파일 읽기를 하지 않고 안내만 한 번", async () => {
    const w = cw2();
    let calls = 0;
    const io2 = { read: async () => { calls++; return null; }, baseline: async () => { calls++; return null; } };
    const many = Array.from({ length: BULK + 1 }, (_, i) => ({ path: `C:/p/Library/a${i}.bin`, kind: "modify" as const }));
    await applyFsChanges(w, "C:/p", many, io2, "t", 1_000_000);
    await applyFsChanges(w, "C:/p", many, io2, "t", 1_005_000);
    expect(calls).toBe(0);
    expect(w.files.length).toBe(0);
    expect(w.log.filter((e) => e.kind === "note").length).toBe(1);
  });
});
