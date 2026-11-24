// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { createWork } from "./work.svelte";
import { createCodexAdapter } from "./codexAdapter";

const io = { read: async () => ({ text: "x", binary: false, encoding: "utf-8", size: 1 }), baseline: async () => null };

describe("codexAdapter", () => {
  it("명령 실행: 시작 → 완료(출력·종료코드), 턴마다 다른 key", () => {
    const work = createWork();
    const a = createCodexAdapter(work, "C:\\p", io);
    a.setTurn(1);
    const cmd = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "npm test"`;
    a.handle({ type: "item.started", item: { id: "item_1", type: "command_execution", command: cmd, aggregated_output: "", exit_code: null } });
    expect(work.findFile("cmd:1:item_1")).toMatchObject({ kind: "run", label: "npm test", status: "running" });
    expect(work.ui.status).toBe("실행: npm test");
    a.handle({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: cmd, aggregated_output: "ok", exit_code: 1 } });
    expect(work.findFile("cmd:1:item_1")).toMatchObject({ status: "error", content: `$ ${cmd}\nok` });
    expect(work.log.find((e) => e.key === "1:item_1")).toMatchObject({ verb: "run", status: "error", meta: "종료 1" });
    a.setTurn(2);
    a.handle({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "dir" } });
    expect(work.files.length).toBe(2);
  });
  it("agent_message는 로그 본문", () => {
    const work = createWork();
    const a = createCodexAdapter(work, "C:\\p", io);
    a.setTurn(1);
    a.handle({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "끝났어요" } });
    expect(work.log[0]).toMatchObject({ kind: "ai", text: "끝났어요" });
  });
  it("file_change 항목은 파일 목록에 반영", async () => {
    const work = createWork();
    const a = createCodexAdapter(work, "C:\\p", io);
    a.setTurn(3);
    a.handle({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "src/a.ts", kind: "add" }] } });
    await a.flush();
    expect(work.files[0]).toMatchObject({ key: "c:/p/src/a.ts", content: "x", prev: "" });
  });
});
