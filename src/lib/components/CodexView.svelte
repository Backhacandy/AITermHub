<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { setWorking } from "$lib/stats.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { register as registerStorage } from "$lib/work/storageRegistry";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { batcher } from "$lib/work/batch";
  import { createWork } from "$lib/work/work.svelte";
  import { userText } from "$lib/work/userText";
  import { classifyCodexStderr, PATCH_NOTE } from "$lib/work/codexLog";
  import { toTeam } from "$lib/sessions.svelte";
  import { experimentalOn } from "$lib/experimental";
  /** 패치 형식 오류 안내를 이미 띄운 지시(턴) */
  let patchTurn = -1;
  import { createCodexAdapter } from "$lib/work/codexAdapter";
  import { applyFsChanges } from "$lib/work/fsChanges";
  import { tauriIO } from "$lib/work/io";
  import type { FsChange } from "$lib/work/types";
  import WorkLog from "$lib/work/WorkLog.svelte";
  import WorkPanel from "$lib/work/WorkPanel.svelte";
  import PromptBox from "$lib/work/PromptBox.svelte";
  import UsagePanel, { type TurnUsage } from "$lib/work/UsagePanel.svelte";
  import { limits, updateLimits } from "$lib/work/limitsStore.svelte";
  import { fromCodexRateLimits, type Limits } from "$lib/work/limits";
  import { waitMs, atLabel } from "$lib/work/limitWait";
  import { settings } from "$lib/settings.svelte";
  import { createRotator, isLimitError, setBusy } from "$lib/accounts.svelte";
  import { createMeter, observe, codexCompactLimit } from "$lib/work/compactPolicy";
  import { notify, titleFor } from "$lib/notify";
  import { registerTab, changedSince, fills, joinInput } from "$lib/remoteBus.svelte";

  let { id, cwd = "", model = "", effort = "", sandbox = "workspace-write", approval = "on-request", cont = false, resume = "", onthread }:
    {
      id: string; cwd?: string; model?: string; effort?: string; sandbox?: string; approval?: string; cont?: boolean;
      /** 앱을 다시 켤 때 정확히 이어갈 thread id */
      resume?: string;
      /** thread id가 정해지면 알려줌(탭 복원용으로 저장) */
      onthread?: (threadId: string) => void;
    } = $props();

  // codex는 스스로 압축한다(model_auto_compact_token_limit) — 넘길 한도를 비용 비교(또는 설정 %)로 정한다.
  // 기준 0이면 넘기지 않아 codex 기본 동작을 따른다.
  const meter = createMeter();
  let lastUsage: any = null;

  const dir = untrack(() => cwd);
  const work = createWork();
  const io = tauriIO(dir);
  const adapter = createCodexAdapter(work, dir, io);

  let input = $state("");
  let running = $state(false);
  // 세션 상태의 '작업중' 표시
  $effect(() => setWorking(id, running));
  let ready = $state(false);
  let unlisten: UnlistenFn[] = [];
  // 스트림 조각은 모아서 처리(조각마다 화면을 다시 그리면 버벅인다). 지난 차례의 남은 조각은 버린다
  const events = batcher<{ turn: number; line: string }>((x) => {
    if (x.turn === turn) handle(JSON.parse(x.line));
  });
  // 현재 턴 번호 — 중단/이전 턴의 늦은 이벤트를 무시하는 데 쓴다
  let turn = 0;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let rootEl: HTMLDivElement;

  // 컨텍스트: 턴이 끝나면 백엔드가 세션 파일의 마지막 token_count에서 정확한 값을 보내준다
  let ctxLimit = $state(272000);
  let ctxTokens = $state(0);
  // 이번 작업 토큰과, 작업 시작 직전의 한도(작업이 한도를 얼마나 올렸는지 계산용)
  let turnUsage = $state<TurnUsage | null>(null);
  let before = $state<Limits | null>(null);

  // 계정 풀: 한도로 턴이 실패하면 다음 계정으로 같은 thread에 실패한 지시를 다시 보낸다
  const rot = createRotator("codex");
  let myLimits = $derived(rot.limits ?? limits.codex);
  let lastPrompt = "";
  let limitHit = false;
  let turnStart = 0;
  let turnAnswer = "";
  let turnFailed = "";
  const notice = (kind: "done" | "error" | "limit", body?: string) =>
    notify({ kind, title: titleFor(id, "Codex"), body, tabId: id, startedAt: kind === "done" ? turnStart : undefined });

  // 폰(원격 세션 @co)에서 이 탭으로 보낸 지시: 끝나면 결과 글로 돌려준다
  let lastShown = "";
  let remoteDone: ((text: string) => void) | null = null;
  function finishRemote(text: string) {
    const r = remoteDone;
    remoteDone = null;
    r?.(text);
  }
  function remoteSend(text: string): Promise<string> {
    if (!ready || running) return Promise.reject(new Error("Codex 탭이 준비 중이거나 작업 중이에요"));
    return new Promise((res) => {
      remoteDone = res;
      work.note("— 폰에서 보낸 지시 —");
      work.user(text);
      void dispatch(text);
    });
  }
  const unregister = registerTab(untrack(() => id), { kind: "codex", cwd: untrack(() => cwd), running: () => running, last: () => lastShown, send: remoteSend });

  function watchOn() {
    clearTimeout(stopTimer);
    invoke("watch_start", { id, cwd: dir }).catch((e) => work.note(`파일 감시를 켜지 못했어요: ${e}`));
  }
  function watchOff() {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => invoke("watch_stop", { id }).catch(() => {}), 1000);
  }

  function handle(ev: any) {
    if (ev.type === "thread.started") { ready = true; return; }
    if (ev.type === "turn.started") { running = true; return; }
    if (ev.type === "turn.completed" || ev.type === "turn.failed") {
      running = false;
      work.ui.status = "";
      // input_tokens에는 캐시된 입력이 포함돼 있어 빼서 나눠 보여준다
      const u = ev.usage;
      if (u) lastUsage = u;
      if (u) {
        const cached = u.cached_input_tokens || 0;
        turnUsage = { input: Math.max(0, (u.input_tokens || 0) - cached), cached, output: u.output_tokens || 0, running: false };
      } else if (turnUsage) turnUsage.running = false;
      if (ev.type === "turn.failed" && ev.error?.message) {
        if (isLimitError(ev.error.message)) limitHit = true;
        else turnFailed = ev.error.message;
        work.error(ev.error.message);
      }
      return;
    }
    if (ev.type === "error" && ev.message) {
      if (isLimitError(ev.message)) limitHit = true;
      work.error(ev.message);
      return;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") turnAnswer = ev.item.text ?? turnAnswer;
    adapter.handle(ev);
  }

  // 저장공간 정리: 이 탭의 폴더·대화는 지키고, 일하는 동안은 임시 폴더를 건드리지 않는다
  onMount(() =>
    registerStorage(id, {
      repos: () => (dir ? [dir] : []),
      skipWts: () => [],
      skipLanes: () => (running ? [id] : []),
      keepIds: () => [resume],
    }),
  );
  onMount(async () => {
    type Ev = { id: string; turn: number; line: string };
    unlisten.push(await listen<Ev>("codex-event", (e) => {
      if (e.payload.id !== id || e.payload.turn !== turn) return;
      events.push({ turn: e.payload.turn, line: e.payload.line });
    }));
    unlisten.push(await listen<Ev>("codex-stderr", (e) => {
      if (e.payload.id !== id || e.payload.turn !== turn) return;
      events.flush();
      // Codex가 스스로 다시 시도할 내부 로그는 빨간 오류 대신 흐린 안내로(패치 형식 오류는 지시당 한 번)
      const c = classifyCodexStderr(e.payload.line);
      if (c.kind === "patch" && patchTurn !== turn) {
        patchTurn = turn;
        work.note(PATCH_NOTE);
      } else if (c.kind === "note") work.note(c.text);
      else if (c.kind === "error") work.error(c.text);
    }));
    unlisten.push(await listen<{ id: string; turn: number; threadId: string | null; ctx: { used: number; window: number } | null; limits: unknown }>("codex-turn-done", (e) => {
      if (e.payload.id !== id || e.payload.turn !== turn) return;
      events.flush();
      running = false;
      work.ui.status = "";
      watchOff();
      if (e.payload.ctx) {
        ctxTokens = e.payload.ctx.used;
        if (e.payload.ctx.window) ctxLimit = e.payload.ctx.window;
      }
      if (lastUsage) {
        const cached = lastUsage.cached_input_tokens || 0;
        observe(meter, ctxTokens, cached, Math.max(0, (lastUsage.input_tokens || 0) - cached), 1);
        lastUsage = null;
      }
      const lim = fromCodexRateLimits(e.payload.limits);
      updateLimits("codex", lim);
      rot.note(lim);
      if (e.payload.threadId) {
        onthread?.(e.payload.threadId);
        // 앱이 만든 Codex 대화 — 일회용 기록 정리에서 지우지 않게
        void invoke("storage_codex_own", { ids: [e.payload.threadId] }).catch(() => {});
      }
      if (turnAnswer) lastShown = turnAnswer;
      if (limitHit && lastPrompt) {
        void switchAccount();
        return;
      }
      // 작업 중에 보낸 말이 있으면 끝내지 않고 이어서 보낸다
      if (queued.length) {
        const q = queued.join("\n\n");
        queued = [];
        void dispatch(q);
        return;
      }
      if (turnFailed) notice("error", turnFailed);
      else notice("done", turnAnswer);
      finishRemote(`[Codex 답변]\n${turnAnswer || "(답변 없음)"}${changedSince(work.files, turnStart)}${turnFailed ? `\n\n[오류]\n- ${turnFailed}` : ""}`);
    }));
    unlisten.push(await listen<{ id: string; changes: FsChange[] }>("work-fs-change", (e) => {
      if (e.payload.id === id) applyFsChanges(work, dir, e.payload.changes, io, String(turn));
    }));
    // 최근 Codex 세션 기록에서 한도를 읽어 첫 질문 전에도 보여준다
    invoke<unknown>("codex_limits").then((l) => updateLimits("codex", fromCodexRateLimits(l))).catch(() => {});
    if (!dir) { work.error("프로젝트 폴더가 없어요."); return; }

    // '이어서'면 이 폴더의 최신 Codex 세션을 찾아 지난 대화를 보여주고 그 세션으로 이어간다
    let thread: string | null = null;
    if (cont || resume) {
      const past = await invoke<{ threadId: string | null; messages: { role: string; text: string }[] }>(
        "codex_transcript", { cwd: dir, thread: resume || null, limit: 40 }
      ).catch(() => ({ threadId: null, messages: [] }));
      thread = past.threadId;
      past.messages.forEach((p, i) => {
        if (p.role === "compact") work.note("— 여기서 Codex가 대화를 압축함 (이후는 요약으로 이어짐) —");
        else if (p.role === "assistant") work.aiSet(`h${i}`, p.text);
        else {
          const t = userText(p.text);
          if (t !== null) work.user(t);
        }
      });
      work.note(thread ? "— 여기까지 지난 Codex 대화 · 이어서 지시하세요 —" : "이 폴더의 이전 Codex 대화를 찾지 못해 새 대화로 시작합니다");
    }
    try {
      await rot.pick();
      // 전체 권한이 켜져 있으면 샌드박스 해제(직접 고른 읽기 전용은 그대로) — exec에선 승인 창이 없으므로 승인도 묻지 않게
      const full = settings.fullAccess && sandbox !== "read-only";
      await invoke("codex_start", { id, cwd: dir, model: model || null, sandbox: full ? "danger-full-access" : sandbox, approval: full ? "never" : approval, resume: thread, account: rot.id });
      ready = true;
    } catch (e) {
      work.error(`시작 실패: ${e}`);
    }
  });

  /** 작업 중에 보낸 말 — Codex는 도중에 끼어들 수 없어 지금 작업이 끝나면 이어서 보낸다 */
  let queued: string[] = [];
  function interject() {
    const text = input.trim();
    if (!text || !ready) return;
    if (!running) return void send();
    input = "";
    work.user(text);
    queued.push(text);
    work.note("— 지금 작업이 끝나면 이어서 보낼게요 —");
  }

  async function send() {
    if (!input.trim() || running || !ready) return;
    const text = input.trim();
    input = "";
    cancelLimitWait();
    work.user(text);
    await dispatch(text);
  }

  /** 한도가 다 됐고 바꿀 계정도 없음: 풀릴 때까지 기다렸다가 같은 지시를 이어서 보낸다(새로 지시하면 취소) */
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  function waitLimit(resend: () => Promise<void>) {
    const ms = waitMs(rot.usableAt(), Date.now());
    work.note(`⏳ 한도가 다 됐어요 — ${atLabel(Date.now() + ms)}쯤 풀리면 같은 지시를 이어서 보내요 (새로 지시하면 취소돼요)`);
    notice("limit");
    if (limitTimer) clearTimeout(limitTimer);
    limitTimer = setTimeout(async () => {
      limitTimer = null;
      await rot.pick();
      await resend().catch((e) => work.error(`다시 보내지 못했어요: ${e}`));
    }, ms);
  }
  function cancelLimitWait() {
    if (limitTimer) clearTimeout(limitTimer);
    limitTimer = null;
  }

  /** 한도 소진 → 다음 계정으로 같은 thread에 다시 보낸다 */
  async function switchAccount() {
    limitHit = false;
    const sw = await rot.next();
    if (!sw) {
      waitLimit(() => dispatch(lastPrompt));
      finishRemote("[대기] Codex 한도가 다 됐어요 — 풀리면 같은 지시를 이어서 보내요");
      return;
    }
    work.note(`계정 전환: ${sw.from} → ${sw.to} (한도 소진) · 같은 대화로 이어서 다시 보내요`);
    await dispatch(lastPrompt);
  }

  async function dispatch(text: string) {
    lastPrompt = text;
    turnStart = Date.now();
    turnAnswer = "";
    turnFailed = "";
    limitHit = false;
    running = true;
    const sw = await rot.sync();
    if (sw) work.note(`계정 전환: ${sw.from} → ${sw.to} · 같은 대화로 이어서`);
    before = $state.snapshot(myLimits);
    turnUsage = { input: 0, cached: 0, output: 0, running: true };
    turn += 1;
    adapter.setTurn(turn);
    watchOn();
    try {
      const compactLimit = codexCompactLimit(meter, ctxLimit, settings.compactAt);
      await invoke("codex_send", { id, text, turn, compactLimit, account: rot.id, effort: effort || null });
    } catch (e) {
      work.error(`전송 실패: ${e}`);
      running = false;
      watchOff();
      finishRemote(`[오류] 전송 실패: ${e}`);
    }
  }
  function onEsc(e: KeyboardEvent) {
    if (e.key !== "Escape" || !running || !rootEl?.contains(e.target as Node)) return;
    e.preventDefault();
    cancel();
  }
  async function cancel() {
    if (!running) return;
    queued = [];
    await invoke("codex_cancel", { id }).catch(() => {});
    turn += 1; // 중단된 턴의 남은 이벤트 무시(다음 send는 그 다음 번호)
    running = false;
    work.failRunning();
    watchOff();
    work.note("— 중단됨 —");
    finishRemote("[Codex] PC에서 작업을 중단했어요.");
  }

  // GitHub 패널 등에서 넣어 준 글 → 입력창
  $effect(() => {
    const t = fills[id];
    if (t) untrack(() => {
      input = joinInput(input, t);
      delete fills[id];
    });
  });

  $effect(() => setBusy(id, running));

  onDestroy(() => {
    cancelLimitWait();
    events.dispose();
    setWorking(id, false);
    unregister();
    finishRemote("[Codex] 허브에서 탭이 닫혔어요.");
    setBusy(id, false);
    unlisten.forEach((u) => u());
    clearTimeout(stopTimer);
    invoke("codex_stop", { id }).catch(() => {});
    invoke("watch_stop", { id }).catch(() => {});
  });
</script>

{#snippet head()}
  <div class="ph"><span class="t">작업</span>{#if experimentalOn(settings)}<button class="add" title="에이전트를 더해 팀으로 — 지금 대화는 첫 에이전트가 이어받아요" disabled={running} onclick={() => toTeam(id)}>＋ 에이전트</button>{/if}<span class="cfg">{settings.fullAccess && sandbox !== "read-only" ? "전체 권한" : `${sandbox} · ${approval}`}</span></div>
  <UsagePanel lim={myLimits} {before} ctxUsed={ctxTokens} {ctxLimit} turn={turnUsage} />
{/snippet}

<svelte:window onkeydown={onEsc} />

<div class="view" bind:this={rootEl}>
  <div class="left">
    <WorkLog
      {work}
      {running}
      status={work.ui.status}
      empty="Codex"
    />
    <PromptBox bind:value={input} cwd={dir} disabled={!ready} {running} placeholder="Codex에게 지시…" onsend={send} oncancel={cancel} oninterject={interject} />
  </div>
  <WorkPanel {work} header={head} onrequest={(t) => (input = input.trim() ? `${input.trim()}\n\n${t}` : t)} />
</div>

<style>
  .view { display: flex; width: 100%; height: 100%; background: var(--bg); }
  .left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .ph { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; }
  .t { font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .add { margin-left: auto; margin-right: 6px; height: 24px; padding: 0 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-dim); font-size: 11px; cursor: pointer; }
  .add:disabled { opacity: .5; cursor: default; }
  .cfg { font-size: 11px; color: var(--muted); font-family: var(--mono); }
</style>
