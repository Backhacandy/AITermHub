// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 탭의 Codex 에이전트 하나: 지난 대화 이어받기, 지시마다 codex exec(턴), 작업 중에 받은 말은 차례가 끝나면 이어 보내기,
// 한도 시 계정 전환, 내부 로그 정리, 대화 고르기. (예전 PairView의 Codex 부분을 옮긴 것)
import { createWork } from "$lib/work/work.svelte";
import { createCodexAdapter } from "$lib/work/codexAdapter";
import { tauriIO } from "$lib/work/io";
import { fromCodexRateLimits } from "$lib/work/limits";
import { waitMs, atLabel } from "$lib/work/limitWait";
import { createMeter, observe, codexCompactLimit } from "$lib/work/compactPolicy";
import { classifyCodexStderr, PATCH_NOTE } from "$lib/work/codexLog";
import { userText } from "$lib/work/userText";
import { batcher } from "$lib/work/batch";
import { AUTO, laneModel } from "$lib/pair/models";
import { createRotator, isLimitError } from "$lib/accounts.svelte";
import type { Lane, LaneOpts, LaneState } from "./lane";

export function createCodexLane(o: LaneOpts): Lane {
  const { tabId, dir, deps, settings, member } = o;
  const pid = `${tabId}~${member.id}`;
  const work = createWork();
  const adapter = createCodexAdapter(work, dir, deps.io ?? tauriIO(dir));
  const state = $state<LaneState>({ ready: false, running: false, busy: false, memory: "확인 중…", ctx: 0, ctxLimit: 272_000, bg: 0, live: false, quietMin: 0 });
  const meter = createMeter();
  const rot = createRotator("codex");
  const sandbox = () => (settings.fullAccess ? "danger-full-access" : "workspace-write");
  let mset = member.model || AUTO;
  let thread: string | null = null;
  let turn = 0;
  let turnText = "";
  let usage: any = null;
  let limitHit = false;
  let lastPrompt = "";
  let lastModel: string | null = null;
  /** 패치 형식 오류 안내를 이미 띄운 차례 */
  let patchTurn = -1;
  /** 작업 중에 받은 말(도중에 끼어들 수 없어 차례가 끝나면 이어서 보낸다) */
  let later: string[] = [];
  /** 받아 둔 말을 이어 보내며 지난 차례들의 답(그 안의 인계를 버리지 않게) */
  let carry = "";
  const unsub: (() => void)[] = [];
  // 스트림 조각은 모아서 처리(조각마다 화면을 다시 그리면 버벅인다). 지난 차례의 남은 조각은 버린다
  const events = batcher<{ turn: number; line: string }>((x) => {
    if (x.turn === turn) onEvent(JSON.parse(x.line));
  });

  function finish(answer: string, full?: string) {
    state.busy = false;
    lane.onFinish?.(answer, full);
  }

  async function sendRaw(prompt: string) {
    state.running = true;
    turn += 1;
    adapter.setTurn(turn);
    turnText = "";
    limitHit = false;
    const compactLimit = codexCompactLimit(meter, state.ctxLimit, settings.compactAt);
    await deps.invoke("codex_send", { id: pid, text: prompt, turn, compactLimit, model: lastModel, account: rot.id, effort: member.effort || null });
  }

  /** 한도가 다 됐고 바꿀 계정도 없음: 이 차례를 끝내지 않고 풀릴 때까지 기다렸다가 같은 지시를 다시 보낸다(멈춤을 누르면 취소) */
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  function waitLimit(resend: () => Promise<void>) {
    const ms = waitMs(rot.usableAt(), Date.now());
    work.failRunning();
    work.note(`⏳ 한도가 다 됐어요 — ${atLabel(Date.now() + ms)}쯤 풀리면 같은 지시를 이어서 보내요 (멈춤을 누르면 취소)`);
    lane.onLimitOut?.();
    if (limitTimer) clearTimeout(limitTimer);
    limitTimer = setTimeout(async () => {
      limitTimer = null;
      if (!state.busy) return;
      await rot.pick();
      try {
        await resend();
      } catch (e) {
        work.error(`다시 보내지 못했어요: ${e}`);
        finish("");
      }
    }, ms);
  }
  function cancelLimitWait() {
    if (limitTimer) clearTimeout(limitTimer);
    limitTimer = null;
  }

  async function switchAccount() {
    const sw = await rot.next();
    if (!sw) {
      waitLimit(() => sendRaw(lastPrompt));
      return;
    }
    work.note(`🔄 계정 전환: ${sw.from} → ${sw.to} (한도 소진) · 같은 대화로 이어서 다시 보내요`);
    try {
      await sendRaw(lastPrompt);
    } catch (e) {
      work.error(`전환 실패: ${e}`);
      finish("");
    }
  }

  function onEvent(ev: any) {
    if (ev.type === "thread.started" && ev.thread_id && ev.thread_id !== thread) {
      const prev = thread;
      thread = ev.thread_id;
      lane.onSession?.(ev.thread_id, prev);
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") turnText = ev.item.text ?? turnText;
    if (ev.type === "turn.completed" || ev.type === "turn.failed") {
      state.running = false;
      if (ev.usage) usage = ev.usage;
      work.ui.status = "";
      if (ev.type === "turn.failed" && ev.error?.message) {
        if (isLimitError(ev.error.message)) limitHit = true;
        work.error(ev.error.message);
      }
      return; // 차례 끝 처리는 codex-turn-done에서(컨텍스트 값 포함)
    }
    if (ev.type === "error" && ev.message) {
      if (isLimitError(ev.message)) limitHit = true;
      work.error(ev.message);
      return;
    }
    adapter.handle(ev);
  }

  function onTurnDone(p: { ctx: { used: number; window: number } | null; limits: unknown }) {
    state.running = false;
    if (p.ctx) {
      state.ctx = p.ctx.used;
      if (p.ctx.window) state.ctxLimit = p.ctx.window;
    }
    if (usage) {
      const cached = usage.cached_input_tokens || 0;
      observe(meter, state.ctx, cached, Math.max(0, (usage.input_tokens || 0) - cached), 1);
      usage = null;
    }
    rot.note(fromCodexRateLimits(p.limits));
    if (!state.busy) return;
    if (limitHit) {
      turnText = "";
      void switchAccount();
      return;
    }
    const ans = turnText;
    turnText = "";
    // 작업 중에 받아 둔 말이 있으면 끝내지 않고 이어서 보낸다
    if (later.length) {
      const q = later.join("\n\n");
      later = [];
      carry = carry ? `${carry}\n\n${ans}` : ans;
      work.note("— 기다리던 말을 이어서 보내요 —");
      void sendRaw(q).catch((e) => {
        work.error(`전송 실패: ${e}`);
        const full = carry;
        carry = "";
        finish(ans, full);
      });
      return;
    }
    const full = carry ? `${carry}\n\n${ans}` : undefined;
    carry = "";
    finish(ans, full);
  }

  const lane: Lane = {
    member,
    work,
    state,
    pid,
    sessionId: () => thread,
    tag: () => `w${member.id}${turn}`,
    onFinish: null,
    onLate: null,
    onSession: null,
    onCompacted: null,
    onAutoCompacted: null,
    onUnstuck: null,
    onLimitOut: null,

    async init() {
      unsub.push(
        await deps.listen("codex-event", (e) => {
          if (e.payload.id !== pid || e.payload.turn !== turn) return;
          events.push({ turn: e.payload.turn, line: e.payload.line });
        }),
        await deps.listen("codex-stderr", (e) => {
          if (e.payload.id !== pid || e.payload.turn !== turn) return;
          events.flush();
          // Codex가 스스로 다시 시도할 내부 로그는 빨간 오류 대신 흐린 안내로(패치 형식 오류는 차례당 한 번)
          const c = classifyCodexStderr(e.payload.line);
          if (c.kind === "patch" && patchTurn !== turn) {
            patchTurn = turn;
            work.note(PATCH_NOTE);
          } else if (c.kind === "note") work.note(c.text);
          else if (c.kind === "error") work.error(c.text);
        }),
        await deps.listen("codex-turn-done", (e) => {
          if (e.payload.id !== pid || e.payload.turn !== turn) return;
          events.flush();
          onTurnDone(e.payload);
        }),
      );
    },

    async start(pick?: string | null) {
      const none = { threadId: null, messages: [] as { role: string; text: string }[] };
      const past =
        pick === null
          ? none
          : ((await deps.invoke("codex_transcript", { cwd: dir, thread: pick ?? (member.resume || null), limit: 20 }).catch(() => none)) ?? none);
      const prev = thread;
      thread = past.threadId;
      if (pick !== undefined) lane.onSession?.(thread ?? "", prev);
      else if (thread && thread !== member.resume) lane.onSession?.(thread, null);
      // role "compact" = 새 버전 codex가 대화를 압축해 새 세션으로 넘긴 지점
      let shown = 0;
      past.messages.forEach((p: { role: string; text: string }, i: number) => {
        if (p.role === "compact") return work.note("— 여기서 Codex가 대화를 압축함 (이후는 요약으로 이어짐) —");
        const t = p.role === "assistant" ? p.text : userText(p.text);
        if (t === null) return;
        shown++;
        if (p.role === "assistant") work.aiSet(`h${i}`, t);
        else work.user(t);
      });
      state.memory = thread ? `이전 대화 ${shown}개` : "새 대화";
      if (thread) work.note("— 여기까지 이 폴더에서 Codex와 나눈 지난 대화 —");
      try {
        await rot.pick();
        await deps.invoke("codex_start", { id: pid, cwd: dir, model: null, sandbox: sandbox(), approval: "never", resume: thread, account: rot.id });
        state.ready = true;
      } catch (e) {
        work.error(`Codex 시작 실패: ${e}`);
        state.memory = "시작 실패";
      }
    },

    async send(prompt: string, text: string) {
      state.busy = true;
      carry = "";
      lastPrompt = prompt;
      lastModel = laneModel("codex", mset, text);
      try {
        // 👤 계정 패널에서 전환했으면 이번 지시부터 그 계정으로
        const sw = await rot.sync();
        if (sw) work.note(`🔄 계정 전환: ${sw.from} → ${sw.to} · 같은 대화로 이어서`);
        await sendRaw(prompt);
      } catch (e) {
        state.busy = false;
        state.running = false;
        work.error(`전송 실패: ${e}`);
        throw e;
      }
    },

    interject(text: string) {
      work.user(text);
      later.push(text);
      work.note("— 지금 작업이 끝나면 이어서 보낼게요 —");
    },

    async stop() {
      later = [];
      cancelLimitWait();
      await deps.invoke("codex_cancel", { id: pid }).catch(() => {});
      state.busy = false;
      state.running = false;
      work.failRunning();
      work.note("— 중단됨 —");
    },

    async pickSession(sel: string | null) {
      if (state.busy) return;
      state.ready = false;
      work.clear();
      state.ctx = 0;
      await lane.start(sel);
    },

    setEffort(e: string) {
      member.effort = e || undefined;
    },

    setModel(m: string) {
      mset = m;
      member.model = m;
    },

    tick() {},

    dispose() {
      cancelLimitWait();
      events.dispose();
      unsub.forEach((u) => u());
      deps.invoke("codex_stop", { id: pid }).catch(() => {});
    },
  };
  return lane;
}
