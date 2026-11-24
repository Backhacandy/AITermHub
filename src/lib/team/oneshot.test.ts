// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi, beforeEach } from "vitest";
const calls: { cmd: string; args: any }[] = [];
let fail = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    calls.push({ cmd, args });
    if (cmd === "accounts_pick") return "acc1";
    if (cmd === "claude_oneshot") {
      if (fail) throw new Error("시간 초과");
      return { assign: [] };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
import { quickJson } from "./oneshot";

describe("단발 호출", () => {
  beforeEach(() => { calls.length = 0; fail = false; });
  it("기본 Sonnet, 정하면 그 모델로, 지금 쓰는 Claude 계정으로", async () => {
    expect(await quickJson("C:\p", "sys", "prompt", { type: "object" })).toEqual({ assign: [] });
    const c = calls.find((x) => x.cmd === "claude_oneshot")!;
    expect(c.args).toMatchObject({ cwd: "C:\p", model: "sonnet", system: "sys", prompt: "prompt", account: "acc1" });
    await quickJson("C:\p", "s", "p", {}, "opus");
    expect(calls.filter((x) => x.cmd === "claude_oneshot").at(-1)!.args.model).toBe("opus");
  });
  it("실패하면 null", async () => {
    fail = true;
    expect(await quickJson("C:\p", "s", "p", {})).toBeNull();
  });
});
