// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "accounts_pick" ? "acc" : cmd === "accounts_list" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
import { createCodexLane } from "./codexLane.svelte";
import type { Member } from "./team";

function fake() {
  const calls: { cmd: string; args: any }[] = [];
  const subs = new Map<string, ((e: { payload: any }) => void)[]>();
  const deps = {
    invoke: async (cmd: string, args: any = {}) => {
      calls.push({ cmd, args });
      if (cmd === "codex_transcript") return { threadId: "T1", messages: [] };
      return null;
    },
    listen: async (ev: string, cb: (e: { payload: any }) => void) => {
      subs.set(ev, [...(subs.get(ev) ?? []), cb]);
      return () => {};
    },
    io: { read: async () => null, baseline: async () => null },
  };
  const emit = (ev: string, payload: any) => (subs.get(ev) ?? []).forEach((cb) => cb({ payload }));
  const sends = () => calls.filter((c) => c.cmd === "codex_send");
  return { calls, deps, emit, sends };
}
const member: Member = { id: "m2", name: "API", cli: "codex", model: "gpt-6-luna", purpose: "", areas: [] };
const settings = { fullAccess: false, compactAt: 0 } as any;

async function ready() {
  const f = fake();
  const lane = createCodexLane({ tabId: "t1", dir: "C:\\p", member: { ...member }, deps: f.deps, settings });
  await lane.init();
  await lane.start();
  const say = (turn: number, text: string) => {
    f.emit("codex-event", { id: "t1~m2", turn, line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) });
    f.emit("codex-turn-done", { id: "t1~m2", turn, ctx: null, limits: null });
  };
  return { f, lane, say };
}

describe("Codex 에이전트", () => {
  it("저장된 thread로 시작, 보내고 차례가 끝나면 onFinish", async () => {
    const { f, lane, say } = await ready();
    expect(f.calls.find((c) => c.cmd === "codex_start")!.args).toMatchObject({ id: "t1~m2", resume: "T1" });
    const done: string[] = [];
    lane.onFinish = (a) => done.push(a);
    await lane.send("P", "t");
    expect(f.sends()[0].args).toMatchObject({ id: "t1~m2", text: "P", turn: 1, model: "gpt-6-luna" });
    say(1, "답");
    expect(done).toEqual(["답"]);
    expect(lane.state.busy).toBe(false);
  });

  it("일하는 중에 보낸 말은 차례가 끝나면 이어서 보내고, 그다음에 끝낸다", async () => {
    const { f, lane, say } = await ready();
    const done: string[] = [];
    const fulls: (string | undefined)[] = [];
    lane.onFinish = (a, full) => { done.push(a); fulls.push(full); };
    await lane.send("P", "t");
    lane.interject("x");
    say(1, "첫 답\n### 인계\n- 요청: @화면 버튼");
    expect(done).toEqual([]);
    expect(f.sends()[1].args).toMatchObject({ text: "x", turn: 2 });
    say(2, "둘째 답");
    expect(done).toEqual(["둘째 답"]);
    // 이어 보낸 말 때문에 첫 차례의 인계가 버려지지 않는다
    expect(fulls[0]).toMatch(/요청: @화면 버튼[\s\S]*둘째 답/);
  });

  it("패치 형식 오류는 지시당 한 번만 안내", async () => {
    const { f, lane } = await ready();
    await lane.send("P", "t");
    const line = "2026-10-24T02:30:03.5Z ERROR codex_core::tools::router: error=apply_patch verification failed: x";
    f.emit("codex-stderr", { id: "t1~m2", turn: 1, line });
    f.emit("codex-stderr", { id: "t1~m2", turn: 1, line });
    expect(lane.work.log.filter((e) => JSON.stringify(e).includes("패치 형식")).length).toBe(1);
  });
});

describe("Codex 에이전트 생각 깊이", () => {
  it("고른 생각 깊이를 지시마다 넘기고, 기본이면 null", async () => {
    const { f, lane, say } = await ready();
    await lane.send("P", "t");
    expect(f.sends()[0].args.effort).toBeNull();
    say(1, "답");
    lane.setEffort("low");
    await lane.send("Q", "t");
    expect(f.sends()[1].args.effort).toBe("low");
  });
});
