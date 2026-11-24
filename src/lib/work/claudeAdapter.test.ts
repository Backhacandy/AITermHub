// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { createWork } from "./work.svelte";
import { createClaudeAdapter } from "./claudeAdapter";
import type { WorkIO } from "./types";

const se = (event: any) => ({ type: "stream_event", event });
const start = (index: number, block: any) => se({ type: "content_block_start", index, content_block: block });
const json = (index: number, partial_json: string) => se({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
const text = (index: number, t: string) => se({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
const result = (id: string, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error }] } });

function setup(disk: Record<string, string>) {
  const work = createWork();
  const io: WorkIO = {
    read: async (p) => (p in disk ? { text: disk[p], binary: false, encoding: "utf-8", size: disk[p].length } : null),
    baseline: async () => null,
  };
  return { work, a: createClaudeAdapter(work, "C:\\p", io) };
}

describe("claudeAdapter", () => {
  it("답변 텍스트를 스트리밍하고 최종 assistant 메시지로 중복 추가하지 않는다", () => {
    const { work, a } = setup({});
    a.handle(se({ type: "message_start", message: { id: "m1" } }));
    a.handle(start(0, { type: "text", text: "" }));
    a.handle(text(0, "확인"));
    a.handle(text(0, "할게요"));
    a.handle({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "확인할게요" }] } });
    expect(work.log.filter((e) => e.kind === "ai").map((e) => e.text)).toEqual(["확인할게요"]);
  });

  it("Write 내용이 작성되는 대로 라이브로 보이고, 결과 후 디스크 내용으로 확정", async () => {
    const disk: Record<string, string> = {};
    const { work, a } = setup(disk);
    a.handle(se({ type: "message_start", message: { id: "m1" } }));
    a.handle(start(1, { type: "tool_use", id: "tu1", name: "Write", input: {} }));
    a.handle(json(1, String.raw`{"file_path":"C:\\p\\b.txt","content":"hel`));
    await a.flush();
    a.handle(json(1, String.raw`lo\nwor`));
    const f = work.findFile("c:/p/b.txt")!;
    expect(f).toMatchObject({ writing: true, content: "hello\nwor", label: "b.txt", prev: "" });
    expect(work.ui.live).toBe("c:/p/b.txt");
    expect(work.ui.status).toBe("b.txt 작성 중");

    disk["C:\\p\\b.txt"] = "hello\nworld";
    a.handle(result("tu1"));
    await a.flush();
    expect(f).toMatchObject({ writing: false, content: "hello\nworld", added: 2, removed: 0, status: "done" });
    expect(work.log.find((e) => e.key === "tu1")).toMatchObject({ verb: "edit", text: "b.txt", status: "done", meta: "+2 −0" });
  });

  it("Edit은 기존 내용 안에서 바뀌는 자리에 새 내용을 끼워 보여준다", async () => {
    const disk: Record<string, string> = { "C:\\p\\a.txt": "line1\nline2\n" };
    const { work, a } = setup(disk);
    a.handle(se({ type: "message_start", message: { id: "m2" } }));
    a.handle(start(0, { type: "tool_use", id: "tu2", name: "Edit", input: {} }));
    a.handle(json(0, String.raw`{"file_path":"C:\\p\\a.txt","old_string":"line2","new_string":"LI`));
    await a.flush();
    expect(work.findFile("c:/p/a.txt")).toMatchObject({ content: "line1\nLI\n", prev: "line1\nline2\n", writing: true });
  });

  it("Bash는 명령 항목을 만들고 결과를 출력으로", async () => {
    const { work, a } = setup({});
    a.handle(se({ type: "message_start", message: { id: "m3" } }));
    a.handle(start(0, { type: "tool_use", id: "tu3", name: "Bash", input: {} }));
    a.handle(json(0, `{"command":"npm test"}`));
    expect(work.findFile("cmd:tu3")).toMatchObject({ kind: "run", label: "npm test", status: "running" });
    a.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu3", content: "3 passed" }] } });
    await a.flush();
    expect(work.findFile("cmd:tu3")).toMatchObject({ status: "done", content: "$ npm test\n3 passed" });
    expect(work.log.find((e) => e.key === "tu3")).toMatchObject({ verb: "run", text: "npm test", status: "done", fileKey: "cmd:tu3" });
  });

  it("부분 스트림 없이 완성된 tool_use만 와도 반영", async () => {
    const { work, a } = setup({});
    a.handle({ type: "assistant", message: { id: "m4", content: [{ type: "tool_use", id: "tu4", name: "Read", input: { file_path: "C:\\p\\r.ts" } }] } });
    expect(work.log.find((e) => e.key === "tu4")).toMatchObject({ verb: "read", text: "r.ts" });
  });

  it("이미지 같은 바이너리를 Read하면 내용 대신 바이너리로 표시", async () => {
    const work = createWork();
    const io: WorkIO = { read: async () => ({ text: "", binary: true, encoding: "binary", size: 5000 }), baseline: async () => null };
    const a = createClaudeAdapter(work, "C:\\p", io);
    a.handle({ type: "assistant", message: { id: "m6", content: [{ type: "tool_use", id: "tu6", name: "Read", input: { file_path: "C:\\p\\shot.png" } }] } });
    a.handle(result("tu6"));
    await a.flush();
    expect(work.findFile("c:/p/shot.png")).toMatchObject({ kind: "read", binary: true, content: "", size: 5000 });
  });

  it("서브에이전트 내부 이벤트는 무시", () => {
    const { work, a } = setup({});
    a.handle({ type: "assistant", parent_tool_use_id: "x", message: { id: "m5", content: [{ type: "text", text: "내부" }] } });
    expect(work.log.length).toBe(0);
  });
});
