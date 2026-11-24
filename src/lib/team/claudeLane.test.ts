// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "accounts_pick" ? "acc" : cmd === "accounts_list" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
import { createClaudeLane } from "./claudeLane.svelte";
import type { Member } from "./team";

function fake() {
  const calls: { cmd: string; args: any }[] = [];
  const subs = new Map<string, ((e: { payload: any }) => void)[]>();
  const deps = {
    invoke: async (cmd: string, args: any = {}) => {
      calls.push({ cmd, args });
      if (cmd === "claude_transcript") return { sessionId: "S1", messages: [{ role: "user", text: "안녕" }], ctx: 0 };
      return null;
    },
    listen: async (ev: string, cb: (e: { payload: any }) => void) => {
      subs.set(ev, [...(subs.get(ev) ?? []), cb]);
      return () => {};
    },
    io: { read: async () => null, baseline: async () => null },
  };
  const emit = (ev: string, payload: any) => (subs.get(ev) ?? []).forEach((cb) => cb({ payload }));
  const last = (cmd: string) => [...calls].reverse().find((c) => c.cmd === cmd);
  return { calls, deps, emit, last };
}
const member = (extra: Partial<Member> = {}): Member => ({ id: "m1", name: "화면", cli: "claude", model: "opus", purpose: "", areas: [], ...extra });
const settings = { fullAccess: false, compactAt: 0, releaseIdle: true } as any;

describe("Claude 에이전트", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function ready(extra: Partial<Member> = {}) {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:\\p", member: member(extra), deps: f.deps, settings });
    await lane.init();
    await lane.start();
    // 스트림 이벤트는 모아서 처리된다 → 보낸 뒤 모으는 시간만큼 흘린다
    const ev = (line: object) => {
      f.emit("claude-event", { id: "t1~m1", gen: f.last("claude_start")!.args.gen, line: JSON.stringify(line) });
      vi.advanceTimersByTime(100);
    };
    return { f, lane, ev };
  }

  it("팀원은 첫 지시 때 띄운다(lazy) — 켤 때는 지난 대화만 불러오고, 보내면 그 대화로 시작해 보낸다", async () => {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:\p", member: member(), deps: f.deps, settings, lazy: true });
    await lane.init();
    await lane.start();
    expect(f.calls.some((c) => c.cmd === "claude_start")).toBe(false);
    expect(lane.state.ready).toBe(true);
    expect(lane.state.memory).toBe("이전 대화 1개");
    void lane.send("P", "t");
    await vi.advanceTimersByTimeAsync(50);
    expect(f.last("claude_start")!.args).toMatchObject({ id: "t1~m1", resume: "S1" });
    const iStart = f.calls.findIndex((c) => c.cmd === "claude_start");
    const iSend = f.calls.findIndex((c) => c.cmd === "claude_send");
    expect(iSend).toBeGreaterThan(iStart);
    // 팀장은 바로 띄운다
    const g = fake();
    const ld = createClaudeLane({ tabId: "t1", dir: "C:\p", member: member({ lead: true }), deps: g.deps, settings, lazy: true });
    await ld.init();
    await ld.start();
    expect(g.calls.some((c) => c.cmd === "claude_start")).toBe(true);
  });

  it("지난 대화를 불러와 그 대화로 시작", async () => {
    const { f, lane } = await ready();
    expect(f.calls.findIndex((c) => c.cmd === "claude_transcript")).toBeLessThan(f.calls.findIndex((c) => c.cmd === "claude_start"));
    expect(f.last("claude_start")!.args).toMatchObject({ id: "t1~m1", resume: "S1", model: "opus" });
    expect(lane.state.ready).toBe(true);
    expect(lane.state.memory).toBe("이전 대화 1개");
  });

  it("보내고, 답이 끝나면 onFinish", async () => {
    const { f, lane, ev } = await ready();
    const done: string[] = [];
    lane.onFinish = (a) => done.push(a);
    await lane.send("P", "t");
    expect(f.last("claude_send")!.args).toEqual({ id: "t1~m1", text: "P" });
    expect(lane.state.busy).toBe(true);
    ev({ type: "result", result: "답", usage: {} });
    expect(done).toEqual(["답"]);
    expect(lane.state.busy).toBe(false);
  });

  it("일하는 중에 보낸 말은 바로", async () => {
    const { f, lane } = await ready();
    await lane.send("P", "t");
    lane.interject("x");
    expect(f.last("claude_send")!.args.text).toBe("x");
  });

  it("백그라운드 작업이 있으면 재우지 않고, 끝나면 2분 뒤 재운다", async () => {
    const { f, lane, ev } = await ready();
    ev({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b" }] });
    vi.advanceTimersByTime(3 * 60_000);
    lane.tick();
    expect(f.last("claude_sleep")).toBeUndefined();
    ev({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    vi.advanceTimersByTime(2 * 60_000);
    lane.tick();
    expect(f.last("claude_sleep")!.args).toEqual({ id: "t1~m1" });
  });

  it("지시 없이 스스로 이어 일하는 중(백그라운드가 끝나 이어 답함)에는 재우지 않는다", async () => {
    const { f, lane, ev } = await ready();
    ev({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "node verify.mjs" } }] } });
    expect(lane.state.running).toBe(true);
    vi.advanceTimersByTime(3 * 60_000);
    lane.tick();
    expect(f.last("claude_sleep")).toBeUndefined();
  });

  // 11/17 MyDocs m3: 8분 제한 명령이 3시간 24분 동안 끝나지 않았는데 '작업중'으로만 보였다
  it("제한을 한참 넘기고 출력도 없는 명령은 멈추고, 같은 대화에 이어서 하라고 보낸다", async () => {
    const { f, lane, ev } = await ready();
    const done: string[] = [];
    const unstuck: string[] = [];
    lane.onFinish = (a) => done.push(a);
    lane.onUnstuck = (t) => unstuck.push(t);
    await lane.send("P", "t");
    ev({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "node verify.mjs out/a.webm", timeout: 120_000 } }] } });
    vi.advanceTimersByTime(6 * 60_000);
    lane.tick();
    expect(f.last("claude_interrupt")).toBeUndefined(); // 2분 제한 + 5분 여유 전
    expect(lane.state.quietMin).toBe(0);
    vi.advanceTimersByTime(2 * 60_000);
    lane.tick();
    expect(f.last("claude_interrupt")!.args).toEqual({ id: "t1~m1" });
    expect(lane.state.quietMin).toBeGreaterThanOrEqual(8);
    expect(unstuck[0]).toContain("node verify.mjs");
    // 멈춘 차례의 끝(오류)은 지시의 끝으로 보지 않고, 이어서 하라고 보낸다
    ev({ type: "result", subtype: "error_during_execution", is_error: true, usage: {} });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toEqual([]);
    expect(lane.state.busy).toBe(true);
    expect(f.last("claude_send")!.args.text).toContain("분째 끝나지 않고");
    expect(lane.state.quietMin).toBe(0);
  });

  it("멈춤 요청이 1분 안에 안 먹히면 그 명령이 띄운 프로그램을 끈다", async () => {
    const { f, lane, ev } = await ready();
    await lane.send("P", "t");
    const at = Date.now();
    ev({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "node verify.mjs", timeout: 120_000 } }] } });
    vi.advanceTimersByTime(8 * 60_000);
    lane.tick();
    expect(f.last("claude_interrupt")).toBeTruthy();
    vi.advanceTimersByTime(61_000);
    lane.tick();
    const k = f.last("claude_kill_since")!.args;
    expect(k.id).toBe("t1~m1");
    expect(k.since).toBeGreaterThanOrEqual(at - 5_000);
    expect(k.since).toBeLessThanOrEqual(at + 100);
  });

  it("도구 결과가 오면 열린 명령에서 빠진다(제한을 넘겨도 풀지 않음)", async () => {
    const { f, lane, ev } = await ready();
    await lane.send("P", "t");
    ev({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
    ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
    vi.advanceTimersByTime(20 * 60_000);
    lane.tick();
    expect(f.last("claude_interrupt")).toBeUndefined();
  });

  it("추가한 에이전트는 MCP 없이", async () => {
    const { f } = await ready({ lean: true });
    expect(f.last("claude_start")!.args.lean).toBe(true);
  });
});

describe("Claude 에이전트 스트림 모아 처리", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("종료 이벤트 전에 모아 둔 결과를 먼저 처리하고, 다시 시작한 뒤 옛 조각은 버린다", async () => {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:\\p", member: member(), deps: f.deps, settings });
    await lane.init();
    await lane.start();
    const done: string[] = [];
    lane.onFinish = (a) => done.push(a);
    await lane.send("P", "t");
    const gen = f.last("claude_start")!.args.gen;
    f.emit("claude-event", { id: "t1~m1", gen, line: JSON.stringify({ type: "result", result: "답", usage: {} }) });
    expect(done).toEqual([]);
    f.emit("claude-exit", { id: "t1~m1", gen });
    expect(done).toEqual(["답"]);
    // 대화를 바꾸면(gen 증가) 그 전에 쌓인 조각은 처리하지 않는다
    f.emit("claude-event", { id: "t1~m1", gen: f.last("claude_start")!.args.gen, line: JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9, post_tokens: 5 } }) });
    await lane.pickSession(null);
    vi.advanceTimersByTime(100);
    expect(lane.work.log.some((e) => e.kind === "note" && e.text.includes("압축"))).toBe(false);
  });
});

describe("Claude 에이전트 생각 깊이", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("저장된 값으로 시작하고, 바꾸면 다음 지시 때 같은 대화로 다시 시작", async () => {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:\\p", member: member({ effort: "high" }), deps: f.deps, settings });
    await lane.init();
    await lane.start();
    expect(f.last("claude_start")!.args.effort).toBe("high");
    const n = f.calls.filter((c) => c.cmd === "claude_start").length;
    lane.setEffort("max");
    expect(f.calls.filter((c) => c.cmd === "claude_start").length).toBe(n);
    await lane.send("P", "t");
    expect(f.last("claude_start")!.args).toMatchObject({ effort: "max", resume: "S1" });
    expect(f.calls.filter((c) => c.cmd === "claude_start").length).toBe(n + 1);
  });
});

describe("Claude 에이전트 인계 놓치지 않기", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("한 차례에 쓴 글을 모두 full로, 백그라운드 뒤 스스로 이어 쓴 답은 onLate로", async () => {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:/p", member: member(), deps: f.deps, settings });
    await lane.init();
    await lane.start();
    const gen = f.last("claude_start")!.args.gen;
    const ev = (line: object) => { f.emit("claude-event", { id: "t1~m1", gen, line: JSON.stringify(line) }); vi.advanceTimersByTime(100); };
    const done: [string, string | undefined][] = [];
    const late: string[] = [];
    lane.onFinish = (a, full) => done.push([a, full]);
    lane.onLate = (full) => late.push(full);
    await lane.send("P", "t");
    ev({ type: "assistant", message: { content: [{ type: "text", text: "작업했어요\n### 인계\n- 요청: @화면 버튼" }] } });
    ev({ type: "assistant", message: { content: [{ type: "text", text: "빌드는 백그라운드로 돌려 둘게요" }] } });
    ev({ type: "result", result: "빌드는 백그라운드로 돌려 둘게요", usage: {} });
    expect(done).toHaveLength(1);
    expect(done[0][0]).toBe("빌드는 백그라운드로 돌려 둘게요");
    expect(done[0][1]).toMatch(/요청: @화면 버튼/);
    // 빌드가 끝나 Claude가 스스로 이어 마무리
    ev({ type: "assistant", message: { content: [{ type: "text", text: "빌드 통과\n### 인계\n- 요청: @화면 결과 확인" }] } });
    ev({ type: "result", result: "빌드 통과\n### 인계\n- 요청: @화면 결과 확인", usage: {} });
    expect(late).toEqual(["빌드 통과\n### 인계\n- 요청: @화면 결과 확인"]);
    expect(done).toHaveLength(1);
  });
});

describe("Claude 에이전트 연결 끊김", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("연결 오류로 끝난 차례는 끝내지 않고, 잠시 뒤 같은 대화로 이어서 보낸다(앞서 쓴 인계도 유지)", async () => {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:/p", member: member(), deps: f.deps, settings });
    await lane.init();
    await lane.start();
    const ev = (line: object) => {
      f.emit("claude-event", { id: "t1~m1", gen: f.last("claude_start")!.args.gen, line: JSON.stringify(line) });
      vi.advanceTimersByTime(100);
    };
    const done: [string, string | undefined][] = [];
    lane.onFinish = (a, full) => done.push([a, full]);
    await lane.send("P", "t");
    ev({ type: "assistant", message: { content: [{ type: "text", text: "반쯤 했어요\n### 인계\n- 요청: @화면 버튼" }] } });
    ev({ type: "result", is_error: true, result: "API Error: Connection error.", usage: {} });
    expect(done).toEqual([]);
    expect(lane.state.busy).toBe(true);
    const starts = f.calls.filter((c) => c.cmd === "claude_start").length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.calls.filter((c) => c.cmd === "claude_start").length).toBe(starts + 1);
    expect(f.last("claude_start")!.args.resume).toBe("S1");
    expect(f.last("claude_send")!.args.text).toMatch(/이어서/);
    ev({ type: "assistant", message: { content: [{ type: "text", text: "마무리했어요" }] } });
    ev({ type: "result", result: "마무리했어요", usage: {} });
    expect(done).toHaveLength(1);
    expect(done[0][1]).toMatch(/요청: @화면 버튼[\s\S]*마무리/);
  });
});

describe("Claude 에이전트 로그인 풀림", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("로그인이 풀린 차례는 끝내지 않고 기다렸다가, 다시 로그인되면 같은 대화로 이어서", async () => {
    const f = fake();
    let resume: (() => Promise<void>) | null = null;
    const waits: string[] = [];
    const auth = { lost: false, wait: (_a: string | null, kind: "login" | "expired", r: () => Promise<void>) => { waits.push(kind); resume = r; return () => {}; } };
    const lane = createClaudeLane({ tabId: "t1", dir: "C:/p", member: member(), deps: { ...f.deps, auth }, settings });
    await lane.init();
    await lane.start();
    const ev = (line: object) => {
      f.emit("claude-event", { id: "t1~m1", gen: f.last("claude_start")!.args.gen, line: JSON.stringify(line) });
      vi.advanceTimersByTime(100);
    };
    const done: string[] = [];
    lane.onFinish = (a) => done.push(a);
    await lane.send("P", "t");
    ev({ type: "result", is_error: true, result: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.", usage: {} });
    expect(done).toEqual([]);
    expect(lane.state.busy).toBe(true);
    expect(waits).toEqual(["login"]);
    const starts = f.calls.filter((c) => c.cmd === "claude_start").length;
    await resume!();
    expect(f.calls.filter((c) => c.cmd === "claude_start").length).toBe(starts + 1);
    expect(f.last("claude_send")!.args.text).toMatch(/이어서/);
  });
});

describe("Claude 에이전트 압축 실패", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("압축이 실패하면 다시 압축하지 않고 미뤄 둔 지시를 보내고, 한동안 자동 압축을 쉰다", async () => {
    const f = fake();
    const lane = createClaudeLane({ tabId: "t1", dir: "C:/p", member: member(), deps: f.deps, settings: { ...settings, compactAt: 50 } });
    await lane.init();
    await lane.start();
    const ev = (line: object) => {
      f.emit("claude-event", { id: "t1~m1", gen: f.last("claude_start")!.args.gen, line: JSON.stringify(line) });
      vi.advanceTimersByTime(100);
    };
    const sends = () => f.calls.filter((c) => c.cmd === "claude_send").map((c) => c.args.text as string);
    await lane.send("P", "t");
    ev({ type: "assistant", message: { usage: { input_tokens: 150_000 }, content: [{ type: "text", text: "답" }] } });
    ev({ type: "result", result: "답", usage: {} });
    await lane.send("Q", "t");
    expect(sends().at(-1)).toMatch(/^\/compact/);
    // 압축 실패(경계 이벤트 없이 끝남)
    ev({ type: "result", is_error: true, result: "Compaction failed · conversation could not be reduced below the context limit", usage: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends().at(-1)).toMatch(/Q$/);
    expect(sends().filter((t) => t.startsWith("/compact"))).toHaveLength(1);
    ev({ type: "result", result: "Q 답", usage: {} });
    await lane.send("R", "t");
    expect(sends().at(-1)).toBe("R");
    expect(sends().filter((t) => t.startsWith("/compact"))).toHaveLength(1);
  });
});

describe("에이전트를 새로 만들어 바꿀 때(작업 폴더 옮기기)", () => {
  it("옛 프로세스가 꺼지며 보낸 종료 신호를 새 에이전트가 자기 것으로 받지 않는다", async () => {
    const f = fake();
    const old = createClaudeLane({ tabId: "t1", dir: "C:/p", member: member(), deps: f.deps, settings });
    await old.init();
    await old.start();
    const oldGen = f.last("claude_start")!.args.gen;
    old.dispose();
    const nl = createClaudeLane({ tabId: "t1", dir: "C:/p/.aith/wt/x", member: member(), deps: f.deps, settings });
    await nl.init();
    await nl.start();
    const done: string[] = [];
    nl.onFinish = (a) => done.push(a);
    await nl.send("P", "t");
    // 옛 프로세스의 늦은 종료 신호
    f.emit("claude-exit", { id: "t1~m1", gen: oldGen });
    expect(nl.state.ready).toBe(true);
    expect(done).toEqual([]);
    expect(f.last("claude_start")!.args.gen).not.toBe(oldGen);
  });
});
