<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { setWorking, setBackground } from "$lib/stats.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { register as registerStorage } from "$lib/work/storageRegistry";
  import { freshGen } from "$lib/team/claudeLane.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { batcher } from "$lib/work/batch";
  import { createNetRetry, isNetError, NET_CONTINUE } from "$lib/work/netRetry";
  import { authKind } from "$lib/work/authWait";
  import { authWaiter } from "$lib/work/authWaitApp";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { createWork } from "$lib/work/work.svelte";
  import { userText } from "$lib/work/userText";
  import SessionPicker from "./SessionPicker.svelte";
  import { toTeam } from "$lib/sessions.svelte";
  import { experimentalOn } from "$lib/experimental";
  import { createClaudeAdapter } from "$lib/work/claudeAdapter";
  import { applyFsChanges } from "$lib/work/fsChanges";
  import { tauriIO } from "$lib/work/io";
  import type { FsChange } from "$lib/work/types";
  import WorkLog from "$lib/work/WorkLog.svelte";
  import WorkPanel from "$lib/work/WorkPanel.svelte";
  import PromptBox from "$lib/work/PromptBox.svelte";
  import UsagePanel, { type TurnUsage } from "$lib/work/UsagePanel.svelte";
  import { limits, updateLimits } from "$lib/work/limitsStore.svelte";
  import { fromClaudeEvent, fmtTokens, rejectResetS, type Limits } from "$lib/work/limits";
  import { waitMs, atLabel } from "$lib/work/limitWait";
  import { settings, learnModel } from "$lib/settings.svelte";
  import { createRotator, isLimitError, limitHit, setBusy } from "$lib/accounts.svelte";
  import { createMeter, observe, compacted, shouldCompact, W } from "$lib/work/compactPolicy";
  import { notify, titleFor } from "$lib/notify";
  import { registerTab, fills, joinInput } from "$lib/remoteBus.svelte";
  import { releaseDue, sleepDue, RELEASE_NOTE } from "$lib/work/idleRelease";
  import { sessionToSave } from "$lib/work/sessionPick";

  let { id, cwd = "", model = "", effort = "", permission = "acceptEdits", cont = false, bare = false, resume = "", onsession }:
    {
      id: string; cwd?: string; model?: string; effort?: string; permission?: string; cont?: boolean; bare?: boolean;
      /** 앱을 다시 켤 때 정확히 이어갈 세션 id */
      resume?: string;
      /** 세션 id가 정해지면 알려줌(탭 복원용으로 저장) */
      onsession?: (sessionId: string) => void;
    } = $props();

  // 자동 압축(/compact): 다음 지시 전에 판단 — 기본은 비용 비교(지난 대화를 다시 읽는 비용이 압축 비용을 넘으면),
  // 설정에서 %를 고르면 그 비율을 넘을 때. 재시작했다고 바로 압축하지는 않는다.
  const meter = createMeter();
  // 요약본은 기본적으로 영어로 써져서 이후 답변까지 영어로 흐를 수 있다 → 지시를 붙인다
  const COMPACT_CMD = "/compact 요약은 한국어로 작성하고, 이후에도 사용자와 계속 한국어로 대화할 것";
  /** 압축이 실패한 뒤 자동 압축을 쉬는 시간 */
  const COMPACT_PAUSE_MS = 30 * 60_000;
  // 압축 요약본 메시지(Claude Code 고정 머리말) — 복원 화면에서는 메시지 대신 안내 줄로 보여준다
  const isCompactSummary = (t: string) => t.trimStart().startsWith("This session is being continued from a previous conversation");
  let compacting = false;
  // 계정 풀: 이 탭이 쓰는 계정. 한도로 실패하면 다음 계정으로 같은 대화를 이어 실패한 지시를 다시 보낸다.
  const rot = createRotator("claude");
  // 사용량 표시는 이 탭이 쓰는 계정의 값(계정이 여럿이면 탭마다 다름) — 모르면 마지막으로 본 값
  let myLimits = $derived(rot.limits ?? limits.claude);
  let lastPrompt = "";
  /** 이번 지시를 보낸 시각(짧은 작업은 완료 알림을 하지 않음) */
  let turnStart = 0;
  const notice = (kind: "done" | "error" | "limit", body?: string) =>
    notify({ kind, title: titleFor(id, "Claude"), body, tabId: id, startedAt: kind === "done" ? turnStart : undefined });
  let limitRejected = false;
  // 폰 @상태에 보일 마지막 답변
  let lastShown = "";
  const unregister = registerTab(untrack(() => id), { kind: "claude", cwd: untrack(() => cwd), running: () => running, last: () => lastShown });
  let limitReset: number | null = null;
  /** 압축이 끝나면 보낼 지시 */
  let queued: string | null = null;

  // 컨텍스트 창 크기: result의 modelUsage.contextWindow가 오면 그 값, 아니면 모델명으로 추정
  let ctxLimit = $state(/\[1m\]/i.test(untrack(() => model)) ? 1_000_000 : 200_000);
  let ctxTokens = $state(0);
  // 이번 작업 토큰과, 작업 시작 직전의 한도(작업이 한도를 얼마나 올렸는지 계산용)
  let turnUsage = $state<TurnUsage | null>(null);
  let before = $state<Limits | null>(null);

  // 현재 프로세스의 세대 번호 — 재시작 전 프로세스의 늦은 이벤트를 무시하는 데 쓴다
  // 같은 탭 화면을 다시 만들 때 옛 프로세스의 늦은 종료 신호를 자기 것으로 받지 않게 세대 번호를 겹치지 않게 시작
  let gen = freshGen();
  // 지금 대화의 Claude 세션 id(재시작·이어가기 시 정확히 같은 대화로 --resume)
  let sessionId = $state<string | null>(null);
  /** 사용자가 "새 대화"를 골랐으면 --continue로 최근 대화를 잇지 않는다 */
  let fresh = false;
  let showPicker = $state(false);
  let turn = 0;

  const dir = untrack(() => cwd);
  const work = createWork();
  const io = tauriIO(dir);
  const adapter = createClaudeAdapter(work, dir, io);

  let input = $state("");
  let running = $state(false);
  // 세션 상태의 '작업중' 표시
  /** Claude가 백그라운드로 돌리는 작업 수(빌드 등) — 답이 끝나도 이게 남아 있으면 일하는 중 */
  let bgTasks = $state(0);
  // 백그라운드 작업만 남았으면 "작업중"이 아니라 "백그라운드"로(답은 끝남 — 끝나면 스스로 이어 답할 수 있다)
  $effect(() => setWorking(id, running));
  $effect(() => setBackground(id, !running && bgTasks > 0));
  let ready = $state(false);
  // 전체 권한이 켜져 있으면 기본·편집만 권한으로 저장된 탭도 모두 허용으로(직접 고른 "계획만"은 그대로)
  const startPerm = untrack(() => (settings.fullAccess && (permission === "acceptEdits" || permission === "default" || !permission) ? "bypassPermissions" : permission));
  let perm = $state(startPerm);
  let prevPerm = startPerm;
  let unlisten: UnlistenFn[] = [];
  // 스트림 조각은 모아서 처리(조각마다 화면을 다시 그리면 버벅인다). 다시 시작한 뒤 남은 옛 조각은 버린다
  // 와이파이가 끊기거나 절전에서 깨어 연결 오류로 끝난 차례 → 다시 연결되면 같은 대화로 이어서
  /** 연결·로그인이 돌아온 뒤 같은 대화로 다시 띄워 끊긴 지점부터 이어서 */
  async function resumeAfterDrop(note: string) {
    if (running || !dir) return;
    work.note(note);
    ready = false;
    adapter.reset();
    await start(sessionId);
    await dispatch(NET_CONTINUE);
  }
  const net = createNetRetry({
    note: (t) => work.note(t),
    retry: () => resumeAfterDrop("— 다시 연결됐어요. 같은 대화로 이어서 해요 —"),
  });
  // 로그인이 풀려 멈춘 차례: 다시 로그인되면 이어서(토큰 만료만이면 잠시 뒤). 연달아 만료면 로그인을 기다린다
  let authCancel: (() => void) | null = null;
  let authTries = 0;
  function cancelAuth() {
    authCancel?.();
    authCancel = null;
  }

  const events = batcher<{ gen: number; line: string }>((x) => {
    if (x.gen === gen) handle(JSON.parse(x.line));
  });
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let rootEl: HTMLDivElement;
  // 중단 요청 중(■/Esc) — result가 오면 "중단됨"으로 마무리, 응답이 없으면 같은 세션으로 재시작
  let interrupting = false;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;

  // 파일 감시는 작업하는 동안만(유휴 중 메모리·CPU 0)
  function watchOn() {
    clearTimeout(stopTimer);
    invoke("watch_start", { id, cwd: dir }).catch((e) => work.note(`파일 감시를 켜지 못했어요: ${e}`));
  }
  function watchOff() {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => invoke("watch_stop", { id }).catch(() => {}), 1000);
  }

  function handle(ev: any) {
    lastActive = Date.now();
    if (ev.type === "system" && ev.subtype === "background_tasks_changed") bgTasks = Array.isArray(ev.tasks) ? ev.tasks.length : 0;
    // 끝나는 순간에 끼어든 말은 새 차례로 이어진다 — 다시 일하는 중으로
    if (!running && ev.type === "assistant") {
      running = true;
      turnStart = Date.now();
    }
    if (ev.type === "rate_limit_event") {
      const lim = fromClaudeEvent(ev);
      updateLimits("claude", lim);
      rot.note(lim);
      // 거절 신호는 다시 허용(allowed) 신호가 오면 푼다 — 남아 있으면 다음 오류까지 소진으로 본다
      limitRejected = ev.rate_limit_info?.status === "rejected";
      if (limitRejected) limitReset = rejectResetS(ev.rate_limit_info);
      return;
    }
    if (ev.session_id && ev.session_id !== sessionId) {
      sessionId = ev.session_id;
      onsession?.(ev.session_id);
    }
    if (ev.type === "system") {
      if (ev.subtype === "init") {
        ready = true;
        if (typeof ev.model === "string" && /\[1m\]/i.test(ev.model)) ctxLimit = 1_000_000;
        learnModel(model, ev.model);
      } else if (ev.subtype === "compact_boundary") {
        // 수동(/compact)·자동 압축 모두 여기로 온다
        const m = ev.compact_metadata ?? {};
        if (typeof m.post_tokens === "number") ctxTokens = m.post_tokens;
        compacted(meter, typeof m.post_tokens === "number" ? m.post_tokens : 0);
        compactOk = true;
        work.note(
          typeof m.pre_tokens === "number" && typeof m.post_tokens === "number"
            ? `— 대화 압축 완료: ${fmtTokens(m.pre_tokens)} → ${fmtTokens(m.post_tokens)} 토큰 —`
            : "— 대화 압축 완료 —"
        );
      }
      return;
    }
    if (ev.type === "assistant" && !ev.parent_tool_use_id) {
      // API 호출 1회의 usage = 현재 컨텍스트 크기(입력+캐시). result의 usage는 턴 전체 합계라 부풀려진다.
      const u = ev.message?.usage;
      if (u) ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    if (ev.type === "result") {
      running = false;
      lastActive = Date.now();
      work.ui.status = "";
      if (compacting) {
        compacting = false;
        if (interrupting) {
          interrupting = false;
          clearTimeout(interruptTimer);
          queued = null;
          work.note("— 중단됨 —");
          return;
        }
        // 실패하면(경계 이벤트 없이 끝남 포함) 30분 동안 자동 압축을 쉰다 — 지시마다 실패한 압축에 토큰을 쓰지 않게
        if (ev.is_error || !compactOk) {
          noCompactUntil = Date.now() + COMPACT_PAUSE_MS;
          work.error(`압축 실패: ${ev.result || "대화를 줄이지 못했어요"} — 30분 동안 자동 압축을 쉬어요`);
        }
        const q = queued;
        queued = null;
        if (q) dispatch(q);
        return;
      }
      watchOff();
      const u = ev.usage;
      if (u) observe(meter, ctxTokens, u.cache_read_input_tokens || 0, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), W.write);
      if (u)
        turnUsage = {
          input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          cached: u.cache_read_input_tokens || 0,
          output: u.output_tokens || 0,
          running: false,
        };
      // 보조 모델(haiku 등)도 섞여 오므로 가장 큰 창을 메인 모델 것으로 본다
      const wins = Object.values<any>(ev.modelUsage ?? {}).map((m) => m?.contextWindow || 0);
      if (wins.length && Math.max(...wins) > 0) ctxLimit = Math.max(...wins);
      if (interrupting) {
        interrupting = false;
        clearTimeout(interruptTimer);
        work.failRunning();
        work.note("— 중단됨 —");
      } else if (ev.is_error && lastPrompt && limitHit(limitRejected, ev.result)) {
        void switchAccount();
      } else if (ev.is_error && lastPrompt && authKind(ev.result)) {
        work.failRunning();
        const kind = authKind(ev.result) === "expired" && authTries < 2 ? "expired" : "login";
        authTries += 1;
        work.note(kind === "login" ? "— Claude 로그인이 풀렸어요. 열린 로그인 창에서 다시 로그인하면 같은 대화로 이어서 할게요 —" : "— 로그인 토큰이 만료돼 잠시 뒤 다시 시작해서 이어서 할게요 —");
        cancelAuth();
        authCancel = authWaiter.wait(rot.id, kind, async () => {
          authCancel = null;
          await resumeAfterDrop("— 로그인이 돌아왔어요. 같은 대화로 이어서 해요 —");
        });
      } else if (ev.is_error && lastPrompt && isNetError(ev.result) && net.fail()) {
        work.failRunning();
      } else if (ev.is_error) {
        work.error(ev.result ?? "오류");
        notice("error", ev.result);
      } else {
        net.ok();
        authTries = 0;
        if (typeof ev.result === "string" && ev.result) lastShown = ev.result;
        notice("done", typeof ev.result === "string" ? ev.result : "");
      }
      return;
    }
    adapter.handle(ev);
  }

  // 저장공간 정리: 이 탭의 폴더·대화는 지키고, 프로세스가 떠 있거나 일하는 동안은 임시 폴더를 건드리지 않는다
  onMount(() =>
    registerStorage(id, {
      repos: () => (dir ? [dir] : []),
      skipWts: () => [],
      skipLanes: () => (running || bgTasks > 0 || !released ? [id] : []),
      keepIds: () => [sessionId ?? "", resume],
    }),
  );
  onMount(async () => {
    type Ev = { id: string; gen: number; line: string };
    unlisten.push(await listen<Ev>("claude-event", (e) => {
      if (e.payload.id !== id || e.payload.gen !== gen) return;
      events.push({ gen: e.payload.gen, line: e.payload.line });
    }));
    unlisten.push(await listen<Ev>("claude-stderr", (e) => {
      if (e.payload.id !== id || e.payload.gen !== gen || !e.payload.line.trim()) return;
      events.flush();
      work.error(e.payload.line);
    }));
    unlisten.push(await listen<{ id: string; gen: number }>("claude-exit", (e) => {
      if (e.payload.id === id && e.payload.gen === gen) {
        events.flush();
        ready = false;
        running = false;
        bgTasks = 0;
        work.failRunning();
        work.error("Claude 세션이 종료됐어요");
      }
    }));
    unlisten.push(await listen<{ id: string; changes: FsChange[] }>("work-fs-change", (e) => {
      if (e.payload.id === id) applyFsChanges(work, dir, e.payload.changes, io, `w${turn}`);
    }));

    // '이어서'(또는 탭 복원)면 지난 대화를 불러와 표시하고, 그 세션 id로 정확히 이어간다
    if ((cont || resume) && dir) {
      await showPast(resume || null);
      const keep = sessionToSave(untrack(() => resume), sessionId);
      if (keep) onsession?.(keep);
    }

    await start(sessionId);
  });

  /** 지난 대화를 불러와 화면에 보이고 sessionId를 정한다(session 없으면 폴더의 최근 대화) */
  async function showPast(session: string | null) {
    const past = await invoke<{ sessionId: string | null; messages: { role: string; text: string }[]; ctx?: number }>(
      "claude_transcript", { cwd: dir, session, limit: 40 }
    ).catch(() => ({ sessionId: null, messages: [], ctx: 0 }));
    sessionId = past.sessionId;
    if (past.ctx) ctxTokens = meter.ctx = past.ctx;
    past.messages.forEach((p, i) => {
      if (isCompactSummary(p.text)) work.note("— 여기서 대화가 압축됨 —");
      else if (p.role === "assistant") work.aiSet(`h${i}`, p.text);
      else {
        const t = userText(p.text); // 작업 알림 같은 내부 메시지는 숨김
        if (t !== null) work.user(t);
      }
    });
    if (past.messages.length) work.note("— 여기까지 지난 대화 —");
  }

  /** 이어 갈 대화를 바꾼다(null = 새 대화). 일하는 중에는 못 바꿈 */
  async function pickSession(sel: string | null) {
    showPicker = false;
    if (running) return;
    ready = false;
    gen += 1; // 끄면서 나오는 종료 이벤트는 무시
    await invoke("claude_stop", { id }).catch(() => {});
    adapter.reset();
    work.clear();
    bgTasks = 0;
    ctxTokens = meter.ctx = 0;
    released = false;
    lastActive = Date.now();
    fresh = sel === null;
    if (sel) await showPast(sel);
    else sessionId = null;
    onsession?.(sessionId ?? "");
    await start(sessionId);
  }

  async function start(resume_: string | null = null) {
    if (!dir) { work.error("프로젝트 폴더가 없어요. 새로 만들 때 폴더를 지정하세요."); return; }
    try {
      if (!rot.id) await rot.pick();
      gen += 1;
      await invoke("claude_start", { id, cwd: dir, model: model || null, permission: perm, cont: !fresh && (cont || !!untrack(() => resume)) && !resume_, resume: resume_, bare, gen, account: rot.id, effort: effort || null });
      // claude는 첫 입력을 받아야 init을 내므로, 프로세스가 뜨면 바로 입력 허용
      ready = true;
    } catch (e) {
      work.error(`시작 실패: ${e}`);
    }
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

  /** 한도 소진 → 다음 계정으로 같은 대화를 이어서 재시작하고 실패한 지시를 다시 보낸다 */
  async function switchAccount() {
    const sw = await rot.next(limitReset);
    limitRejected = false;
    if (!sw) {
      watchOff();
      waitLimit(async () => {
        ready = false;
        adapter.reset();
        await start(sessionId);
        await dispatch(lastPrompt);
      });
      return;
    }
    work.failRunning();
    work.note(`계정 전환: ${sw.from} → ${sw.to} (한도 소진) · 같은 대화로 이어서 다시 보내요`);
    ready = false;
    adapter.reset();
    await start(sessionId);
    await dispatch(lastPrompt);
  }

  // 권한 변경 → 같은 대화를 이어서 재시작(맥락을 버리고 처음부터 다시 파악하느라 토큰을 쓰지 않게)
  async function changePerm() {
    if (perm === "bypassPermissions") {
      const ok = await ask("모든 도구(명령 실행·파일 삭제 포함)를 확인 없이 실행합니다. 계속할까요?", {
        title: "모두 허용", kind: "warning",
      }).catch(() => false);
      if (!ok) { perm = prevPerm; return; }
    }
    prevPerm = perm;
    ready = false;
    running = false;
    work.failRunning();
    adapter.reset();
    watchOff();
    work.note(`— 권한 변경(${perm}) · 같은 대화로 재시작 —`);
    await start(sessionId);
  }

  /** ■ 버튼·Esc: 진행 중인 답변만 멈춘다(프로세스·대화 맥락 유지) */
  async function stop() {
    if (!running || interrupting) return;
    queued = null;
    interrupting = true;
    work.ui.status = "중단하는 중…";
    await invoke("claude_interrupt", { id }).catch(() => {});
    // 4초 안에 끝나지 않으면 프로세스를 끄고 같은 세션으로 재시작(맥락 유지)
    clearTimeout(interruptTimer);
    interruptTimer = setTimeout(async () => {
      if (!interrupting) return;
      interrupting = false;
      running = false;
      ready = false;
      work.failRunning();
      adapter.reset();
      watchOff();
      work.note("— 중단됨 (응답이 없어 같은 대화로 재시작) —");
      await start(sessionId);
    }, 4000);
  }
  function onEsc(e: KeyboardEvent) {
    if (e.key !== "Escape" || !running || !rootEl?.contains(e.target as Node)) return;
    e.preventDefault();
    stop();
  }

  /** /compact 실행(진행 중엔 입력 잠금, 끝나면 대기 중인 지시를 보냄) */
  let compactOk = false;
  let noCompactUntil = 0;
  function compact(reason: string) {
    compacting = true;
    compactOk = false;
    running = true;
    work.ui.status = "대화 압축 중…";
    work.note(`— ${reason} · 대화를 압축하는 중(/compact) —`);
    invoke("claude_send", { id, text: COMPACT_CMD }).catch((e) => {
      compacting = false;
      running = false;
      work.error(`압축 요청 실패: ${e}`);
      const q = queued;
      queued = null;
      if (q) dispatch(q);
    });
  }

  /** 작업 중에 보낸 말: Claude는 지금 하던 작업에 바로 이어서 반영한다(터미널의 Claude처럼) */
  async function interject() {
    const text = input.trim();
    if (!text || !ready) return;
    if (!running) return send();
    input = "";
    work.user(text);
    lastActive = Date.now();
    await invoke("claude_send", { id, text }).catch((e) => work.error(`전송 실패: ${e}`));
  }

  async function send() {
    if (!input.trim() || running || !ready) return;
    const text = input.trim();
    input = "";
    cancelLimitWait();
    net.cancel();
    cancelAuth();
    work.user(text);
    await wake();
    lastActive = Date.now();
    // 압축할 때가 됐으면(비용 비교 또는 설정 %) 먼저 압축하고, 끝나면 이 지시를 보낸다
    if (Date.now() >= noCompactUntil && shouldCompact(meter, ctxLimit, settings.compactAt)) {
      queued = text;
      compact(settings.compactAt > 0 ? `컨텍스트 ${Math.round((ctxTokens / ctxLimit) * 100)}% 사용` : `지난 대화(${fmtTokens(ctxTokens)})를 다시 읽는 비용이 압축 비용을 넘어서`);
      return;
    }
    await dispatch(text);
  }

  // 쉬는 프로세스: 잠깐 쉬면 재우고(살려 둔 채 메모리 반납 — 보낼 때 백엔드가 깨움), 오래 쉬면 끄고 다음 지시 때 같은 대화로 다시 띄운다
  let lastActive = Date.now();
  let released = false;
  /** 재운 시점의 lastActive(그 뒤 활동하면 달라져 다시 재울 수 있다) */
  let sleptAt = 0;
  const idleTimer = setInterval(() => {
    if (released || running || compacting || !ready) return;
    if (sleptAt !== lastActive && sleepDue(lastActive, Date.now(), settings, bgTasks)) {
      sleptAt = lastActive;
      invoke("claude_sleep", { id }).catch(() => {});
    }
    if (!releaseDue(lastActive, Date.now(), settings, bgTasks)) return;
    released = true;
    gen += 1; // 끄면서 나오는 종료 이벤트는 무시
    invoke("claude_stop", { id }).catch(() => {});
    work.note(RELEASE_NOTE);
  }, 30_000);
  async function wake() {
    if (!released) return;
    released = false;
    adapter.reset();
    await start(sessionId);
  }

  async function dispatch(text: string) {
    await wake();
    lastActive = Date.now();
    lastPrompt = text;
    turnStart = Date.now();
    limitRejected = false;
    running = true;
    // 👤 계정 패널에서 다른 계정으로 전환했으면 같은 대화로 이어서 재시작
    const sw = await rot.sync();
    if (sw) {
      work.note(`계정 전환: ${sw.from} → ${sw.to} · 같은 대화로 이어서`);
      ready = false;
      adapter.reset();
      await start(sessionId);
    }
    before = $state.snapshot(myLimits);
    turnUsage = { input: 0, cached: 0, output: 0, running: true };
    turn += 1;
    watchOn();
    await invoke("claude_send", { id, text }).catch((e) => {
      work.error(`전송 실패: ${e}`);
      running = false;
      watchOff();
    });
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
    net.cancel();
    cancelAuth();
    events.dispose();
    setWorking(id, false);
    setBackground(id, false);
    clearInterval(idleTimer);
    unregister();
    setBusy(id, false);
    unlisten.forEach((u) => u());
    clearTimeout(stopTimer);
    clearTimeout(interruptTimer);
    invoke("claude_stop", { id }).catch(() => {});
    invoke("watch_stop", { id }).catch(() => {});
  });
</script>

{#snippet head()}
  <div class="ph">
    <span class="t">작업</span>
    {#if experimentalOn(settings)}<button class="pick" title="에이전트를 더해 팀으로 — 지금 대화는 첫 에이전트가 이어받아요" disabled={running} onclick={() => toTeam(id)}>＋ 에이전트</button>{/if}
    <button class="pick" title="이어 갈 대화 고르기" disabled={running || !ready} onclick={() => (showPicker = true)}>대화 ▾</button>
    <select bind:value={perm} onchange={changePerm} class="perm" title="권한">
      <option value="acceptEdits">편집 자동</option>
      <option value="bypassPermissions">모두 허용</option>
      <option value="plan">계획만</option>
      <option value="default">매번 확인</option>
    </select>
  </div>
  <UsagePanel lim={myLimits} {before} ctxUsed={ctxTokens} {ctxLimit} turn={turnUsage} />
{/snippet}

<svelte:window onkeydown={onEsc} />

<div class="view" bind:this={rootEl}>
  {#if showPicker}
    <SessionPicker cli="claude" cwd={dir} current={sessionId} onpick={pickSession} onclose={() => (showPicker = false)} />
  {/if}
  <div class="left">
    <WorkLog
      {work}
      {running}
      status={work.ui.status}
      empty={ready ? "Claude" : "세션 시작 중…"}
    />
    <PromptBox bind:value={input} cwd={dir} disabled={!ready} {running} placeholder={ready ? "Claude에게 지시…" : "시작 중…"} onsend={send} oncancel={stop} oninterject={interject} />
  </div>
  <WorkPanel {work} header={head} onrequest={(t) => (input = input.trim() ? `${input.trim()}\n\n${t}` : t)} />
</div>

<style>
  .view { position: relative; display: flex; width: 100%; height: 100%; background: var(--bg); }
  .left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .ph { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; }
  .t { font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .pick { margin-left: auto; margin-right: 6px; height: 24px; padding: 0 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-dim); font-size: 11px; cursor: pointer; }
  .pick:disabled { opacity: .5; cursor: default; }
  .perm { height: 24px; padding: 0 6px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-dim); font-size: 11px; }
</style>
