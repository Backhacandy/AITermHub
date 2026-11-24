// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 비교 모드: 같은 지시를 Claude와 Codex가 각자의 git 작업 공간(지금 HEAD에서 만든 worktree)에서 동시에 수행 →
// 결과 diff를 나란히 보고 하나를 골라 지금 브랜치에 커밋 하나로 합친다(나머지는 버림).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { createWork, type Work } from "$lib/work/work.svelte";
import { createClaudeAdapter } from "$lib/work/claudeAdapter";
import { createCodexAdapter } from "$lib/work/codexAdapter";
import { tauriIO } from "$lib/work/io";
import { settings } from "$lib/settings.svelte";
import { setBusy, isLimitError } from "$lib/accounts.svelte";

export type Side = "claude" | "codex";
export const SIDES: Side[] = ["claude", "codex"];
export const NAME: Record<Side, string> = { claude: "Claude", codex: "Codex" };
export const DEFAULT_MODEL: Record<Side, string> = { claude: "opus", codex: "gpt-6-astra" };

const TIMEOUT_MS = 30 * 60_000;

export interface Lane {
  side: Side;
  model: string;
  dir: string;
  work: Work;
  status: "idle" | "running" | "done" | "error";
  error: string;
  answer: string;
  /** 입력(캐시 제외)·캐시·출력 토큰 */
  tokens: { input: number; cached: number; output: number };
  startedAt: number;
  endedAt: number;
  diff: string;
  files: string[];
}

export type Phase = "idle" | "preparing" | "running" | "review" | "merged" | "error";

type Deps = { invoke: typeof tauriInvoke; listen: typeof tauriListen };

/** diff 요약: 바뀐 파일 수와 +/− 줄 수 */
export function diffStats(diff: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) files++;
    else if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { files, added, removed };
}

/** 합칠 때 커밋 메시지 */
export function commitMessage(side: Side, text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `비교 모드: ${NAME[side]} 결과 반영 — ${one.length > 60 ? one.slice(0, 59) + "…" : one}`;
}

const PROMPT_TAIL =
  "\n\n(이 폴더는 비교용 작업 공간이에요. 지시대로 파일을 직접 고치고, 끝나면 무엇을 바꿨는지 한국어로 짧게 정리해 주세요. git 커밋은 하지 마세요.)";

export function createCompare(repo: string, busyKey: string, deps: Deps = { invoke: tauriInvoke, listen: tauriListen }) {
  const { invoke, listen } = deps;
  const lane = (side: Side): Lane => ({
    side,
    model: DEFAULT_MODEL[side],
    dir: "",
    work: createWork(),
    status: "idle",
    error: "",
    answer: "",
    tokens: { input: 0, cached: 0, output: 0 },
    startedAt: 0,
    endedAt: 0,
    diff: "",
    files: [],
  });
  const st = $state({
    id: "",
    phase: "idle" as Phase,
    text: "",
    dirty: false,
    error: "",
    merged: "",
    lanes: { claude: lane("claude"), codex: lane("codex") } as Record<Side, Lane>,
  });
  const handlers = new Map<string, { side: Side; handle: (ev: any) => void; timer: ReturnType<typeof setTimeout> }>();
  let unlisten: UnlistenFn[] = [];
  const keyOf = (side: Side) => `cmp:${st.id}:${side}`;

  async function init() {
    unlisten.push(
      await listen<{ key: string; line: string }>("collab-event", (e) => {
        const h = handlers.get(e.payload.key);
        if (!h) return;
        try {
          h.handle(JSON.parse(e.payload.line));
        } catch {
          /* 깨진 줄 무시 */
        }
      }),
      await listen<{ key: string; line: string }>("collab-stderr", (e) => {
        const h = handlers.get(e.payload.key);
        if (h && !/Reading (additional input|prompt) from stdin|no stdin data/i.test(e.payload.line)) st.lanes[h.side].work.error(e.payload.line);
      }),
      await listen<{ key: string }>("collab-done", (e) => {
        const h = handlers.get(e.payload.key);
        if (h) void finish(h.side);
      })
    );
  }

  function onEvent(L: Lane, ev: any, handle: (ev: any) => void) {
    if (L.side === "claude") {
      if (ev.type === "result") {
        if (ev.is_error) L.error = typeof ev.result === "string" ? ev.result : "실패";
        else if (typeof ev.result === "string") L.answer = ev.result;
        const u = ev.usage ?? {};
        L.tokens = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        return;
      }
      if (ev.type === "rate_limit_event") return;
    } else {
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") L.answer = ev.item.text ?? L.answer;
      const msg = ev.type === "error" ? ev.message : ev.type === "turn.failed" ? ev.error?.message : null;
      if (typeof msg === "string") L.error = msg;
      if (ev.type === "turn.completed" && ev.usage) {
        const cached = ev.usage.cached_input_tokens || 0;
        L.tokens = { input: Math.max(0, (ev.usage.input_tokens || 0) - cached), cached, output: ev.usage.output_tokens || 0 };
      }
    }
    handle(ev);
  }

  async function spawnLane(L: Lane) {
    const full = settings.fullAccess;
    const account = await invoke<string | null>("accounts_pick", { cli: L.side }).catch(() => null);
    const io = tauriIO(L.dir);
    const adapter = L.side === "claude" ? createClaudeAdapter(L.work, L.dir, io) : createCodexAdapter(L.work, L.dir, io);
    if (L.side === "codex") (adapter as ReturnType<typeof createCodexAdapter>).setTurn(1);
    const key = keyOf(L.side);
    const timer = setTimeout(() => {
      L.work.error("시간 초과(30분)로 중단합니다");
      invoke("collab_kill", { key }).catch(() => {});
    }, TIMEOUT_MS);
    handlers.set(key, { side: L.side, handle: (ev) => onEvent(L, ev, (x) => adapter.handle(x)), timer });
    L.status = "running";
    L.startedAt = Date.now();
    await invoke("collab_spawn", {
      spec: {
        key,
        cli: L.side,
        model: L.model,
        cwd: L.dir,
        prompt: st.text + PROMPT_TAIL,
        system_prompt: null,
        tools: full ? "Read,Edit,Write,Glob,Grep,Bash" : "Read,Edit,Write,Glob,Grep",
        json_schema: null,
        permission: full ? "bypassPermissions" : "acceptEdits",
        sandbox: full ? "danger-full-access" : null,
        account,
      },
    }).catch((e) => {
      clearTimeout(timer);
      handlers.delete(key);
      L.status = "error";
      L.error = `시작 실패: ${e}`;
      L.endedAt = Date.now();
    });
  }

  async function finish(side: Side) {
    const L = st.lanes[side];
    const key = keyOf(side);
    const h = handlers.get(key);
    if (h) clearTimeout(h.timer);
    handlers.delete(key);
    invoke("collab_reap", { key }).catch(() => {});
    L.endedAt = Date.now();
    L.files = await invoke<string[]>("collab_changed", { dir: L.dir }).catch(() => []);
    L.diff = await invoke<string>("collab_diff", { dir: L.dir, max: 300_000 }).catch(() => "");
    if (L.error && isLimitError(L.error)) L.error = `한도 소진: ${L.error}`;
    L.status = L.error && !L.diff ? "error" : "done";
    if (SIDES.every((s) => st.lanes[s].status === "done" || st.lanes[s].status === "error")) {
      st.phase = "review";
      setBusy(busyKey, false);
    }
  }

  /** 지시를 두 에이전트에게 보낸다 */
  async function start(text: string, models: Record<Side, string>) {
    if (st.phase === "preparing" || st.phase === "running") return;
    if (st.id && st.phase !== "merged") await invoke("compare_discard", { repo, id: st.id }).catch(() => {});
    st.id = Date.now().toString(36);
    st.text = text.trim();
    st.error = "";
    st.merged = "";
    st.lanes = { claude: lane("claude"), codex: lane("codex") };
    st.phase = "preparing";
    try {
      const p = await invoke<{ claude: string; codex: string; dirty: boolean }>("compare_prepare", { repo, id: st.id });
      st.dirty = p.dirty;
      for (const s of SIDES) {
        st.lanes[s].dir = p[s];
        st.lanes[s].model = models[s] || DEFAULT_MODEL[s];
        st.lanes[s].work.user(st.text);
      }
      st.phase = "running";
      setBusy(busyKey, true);
      await Promise.all(SIDES.map((s) => spawnLane(st.lanes[s])));
      // 둘 다 시작 실패면 바로 결과 단계로
      if (SIDES.every((s) => st.lanes[s].status === "error")) {
        st.phase = "review";
        setBusy(busyKey, false);
      }
    } catch (e) {
      st.phase = "error";
      st.error = String(e);
      setBusy(busyKey, false);
    }
  }

  /** 진행 중인 쪽을 모두 멈춘다(결과 단계로 넘어감) */
  function stop() {
    for (const k of handlers.keys()) invoke("collab_kill", { key: k }).catch(() => {});
  }

  /** 고른 쪽을 지금 브랜치에 합친다 */
  async function accept(side: Side) {
    st.error = "";
    try {
      st.merged = await invoke<string>("compare_accept", { repo, id: st.id, side, message: commitMessage(side, st.text) });
      st.phase = "merged";
    } catch (e) {
      st.error = String(e);
    }
  }

  /** 둘 다 버리고 처음으로 */
  async function discard() {
    stop();
    if (st.id) await invoke("compare_discard", { repo, id: st.id }).catch(() => {});
    st.id = "";
    st.phase = "idle";
    st.lanes = { claude: lane("claude"), codex: lane("codex") };
    setBusy(busyKey, false);
  }

  function dispose() {
    unlisten.forEach((u) => u());
    unlisten = [];
    stop();
    for (const h of handlers.values()) clearTimeout(h.timer);
    handlers.clear();
    setBusy(busyKey, false);
    // 고르지 않은 작업 공간은 정리
    if (st.id && st.phase !== "merged") invoke("compare_discard", { repo, id: st.id }).catch(() => {});
  }

  return { st, init, start, stop, accept, discard, dispose };
}
