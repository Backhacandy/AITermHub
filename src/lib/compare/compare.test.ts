// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
import { createCompare, diffStats, commitMessage } from "./compare.svelte";

function fake(opts: { failCodex?: boolean } = {}) {
  const listeners = new Map<string, ((e: { payload: any }) => void)[]>();
  const calls: { cmd: string; args: any }[] = [];
  const emit = (ev: string, payload: unknown) => (listeners.get(ev) ?? []).forEach((cb) => cb({ payload }));
  const invoke = async (cmd: string, args: any = {}): Promise<any> => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "compare_prepare":
        return { claude: "WT/claude", codex: "WT/codex", dirty: true };
      case "accounts_pick":
        return null;
      case "collab_spawn": {
        const { key, cli } = args.spec;
        setTimeout(() => {
          if (cli === "claude") emit("collab-event", { key, line: JSON.stringify({ type: "result", is_error: false, result: "버튼을 고쳤어요", usage: { input_tokens: 10, output_tokens: 5 } }) });
          else if (opts.failCodex) emit("collab-event", { key, line: JSON.stringify({ type: "turn.failed", error: { message: "boom" } }) });
          else emit("collab-event", { key, line: JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "codex 완료" } }) });
          emit("collab-done", { key });
        }, 0);
        return 1;
      }
      case "collab_changed":
        return args.dir === "WT/codex" && opts.failCodex ? [] : ["src/a.ts"];
      case "collab_diff":
        return args.dir === "WT/codex" && opts.failCodex ? "" : "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
      case "compare_accept":
        return "abc1234";
      default:
        return null;
    }
  };
  const listen = async (ev: string, cb: (e: { payload: any }) => void) => {
    listeners.set(ev, [...(listeners.get(ev) ?? []), cb]);
    return () => {};
  };
  return { deps: { invoke: invoke as any, listen: listen as any }, calls };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};

describe("compare", () => {
  it("diff 요약", () => {
    expect(diffStats("diff --git a/x b/x\n--- a/x\n+++ b/x\n-a\n+b\n+c")).toEqual({ files: 1, added: 2, removed: 1 });
    expect(diffStats("")).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it("커밋 메시지는 고른 쪽과 지시 앞부분", () => {
    expect(commitMessage("codex", "  로그인\n버튼 고쳐 ")).toBe("비교 모드: Codex 결과 반영 — 로그인 버튼 고쳐");
    expect(commitMessage("claude", "가".repeat(80)).length).toBeLessThan(90);
  });

  it("두 에이전트가 각자 작업 공간에서 → 결과 단계 → 고른 쪽 합치기", async () => {
    const be = fake();
    const c = createCompare("C:\\proj", "tab1", be.deps);
    await c.init();
    await c.start("버튼 고쳐", { claude: "sonnet", codex: "gpt-6-astra" });
    await until(() => c.st.phase === "review");
    expect(c.st.dirty).toBe(true);
    const spawns = be.calls.filter((x) => x.cmd === "collab_spawn").map((x) => x.args.spec);
    expect(spawns.map((s) => [s.cli, s.cwd, s.model])).toEqual([
      ["claude", "WT/claude", "sonnet"],
      ["codex", "WT/codex", "gpt-6-astra"],
    ]);
    expect(spawns[0].prompt).toMatch(/^버튼 고쳐/);
    expect(c.st.lanes.claude.answer).toBe("버튼을 고쳤어요");
    expect(c.st.lanes.codex.answer).toBe("codex 완료");
    expect(c.st.lanes.claude.files).toEqual(["src/a.ts"]);
    await c.accept("codex");
    expect(c.st.phase).toBe("merged");
    expect(c.st.merged).toBe("abc1234");
    expect(be.calls.find((x) => x.cmd === "compare_accept")?.args.side).toBe("codex");
    c.dispose();
    // 합친 뒤에는 정리를 다시 하지 않는다(이미 정리됨)
    expect(be.calls.filter((x) => x.cmd === "compare_discard").length).toBe(0);
  });

  it("한쪽이 실패해도 결과 단계로, 고르지 않고 닫으면 작업 공간 정리", async () => {
    const be = fake({ failCodex: true });
    const c = createCompare("C:\\proj", "tab2", be.deps);
    await c.init();
    await c.start("x", { claude: "opus", codex: "gpt-6-astra" });
    await until(() => c.st.phase === "review");
    expect(c.st.lanes.codex.status).toBe("error");
    expect(c.st.lanes.claude.status).toBe("done");
    c.dispose();
    expect(be.calls.filter((x) => x.cmd === "compare_discard").length).toBe(1);
  });
});
