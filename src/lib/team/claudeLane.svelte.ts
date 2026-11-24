// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 탭의 Claude 에이전트 하나: 지난 대화 이어받기, 보내기(모델·계정 맞춤·압축), 작업 중 말 걸기, 한도 시 계정 전환,
// 쉬면 재우기·오래 쉬면 끄기(백그라운드 작업 중에는 안 함), 대화 고르기. (예전 PairView의 Claude 부분을 옮긴 것)
import { createWork } from "$lib/work/work.svelte";
import { createClaudeAdapter } from "$lib/work/claudeAdapter";
import { tauriIO } from "$lib/work/io";
import { fmtTokens, fromClaudeEvent } from "$lib/work/limits";
import { createMeter, observe, compacted, shouldCompact, W, TEAM_COMPACT_WINDOW } from "$lib/work/compactPolicy";
import { stuckCheck, unstuckPrompt, type OpenTool } from "./stuck";
import { releaseDue, sleepDue, RELEASE_NOTE } from "$lib/work/idleRelease";
import { waitMs, atLabel } from "$lib/work/limitWait";
import { rejectResetS } from "$lib/work/limits";
import { userText } from "$lib/work/userText";
import { batcher } from "$lib/work/batch";
import { createNetRetry, isNetError, NET_CONTINUE } from "$lib/work/netRetry";
import { authKind } from "$lib/work/authWait";
import { authWaiter } from "$lib/work/authWaitApp";
import { AUTO, laneModel, modelLabel, effortLabel } from "$lib/pair/models";
import { learnModel } from "$lib/settings.svelte";
import { createRotator, limitHit } from "$lib/accounts.svelte";
import type { Lane, LaneOpts, LaneState } from "./lane";

/** 압축이 실패한 뒤 자동 압축을 쉬는 시간 */
export const COMPACT_PAUSE_MS = 30 * 60_000;
export const COMPACT_CMD = "/compact 요약은 한국어로 작성하고, 이후에도 사용자와 계속 한국어로 대화할 것";
const isCompactSummary = (t: string) => t.trimStart().startsWith("This session is being continued from a previous conversation");

/** lane마다 세대 번호 시작을 다르게 — 같은 탭·같은 에이전트(같은 프로세스 이름)를 새로 만들어 바꿀 때(작업 폴더 옮기기 등)
 *  옛 프로세스가 꺼지며 보낸 종료 신호를 새 lane이 자기 것으로 받아 "답 없이 끝남"으로 처리하지 않게 */
let laneSeq = 0;
/** 새 세대 번호 시작값(한 탭 Claude 화면도 같이 쓴다) */
export const freshGen = () => ++laneSeq * 1_000_000;

export function createClaudeLane(o: LaneOpts): Lane {
  const { tabId, dir, deps, settings, member } = o;
  const pid = `${tabId}~${member.id}`;
  const work = createWork();
  const adapter = createClaudeAdapter(work, dir, deps.io ?? tauriIO(dir));
  const state = $state<LaneState>({ ready: false, running: false, busy: false, memory: "확인 중…", ctx: 0, ctxLimit: 200_000, bg: 0, live: false, quietMin: 0 });
  const meter = createMeter();
  const rot = createRotator("claude");
  const perm = () => (settings.fullAccess ? "bypassPermissions" : "acceptEdits");
  let mset = member.model || AUTO;
  /** 생각 깊이 설정 / 지금 프로세스에 걸린 값("" = 설정 파일 값) */
  let eff = member.effort ?? "";
  let effNow = eff;
  let gen = freshGen();
  let session: string | null = null;
  /** 지금 프로세스가 쓰는 모델(null = CLI 기본) */
  let model: string | null = null;
  let compacting = false;
  /** 이번 압축에서 경계 이벤트를 받았는지(못 받고 끝나면 실패) */
  let compactOk = false;
  /** 압축이 실패하면 이 시각까지 자동 압축을 쉰다 — 실패한 압축을 곧바로 다시 하며 끝없이 토큰을 쓰지 않게 */
  let noCompactUntil = 0;
  /** 압축이 끝나면 보낼 지시 */
  let queued: string | null = null;
  let turnText = "";
  /** 이번 차례에 쓴 글 전부(인계가 중간에 있어도 놓치지 않게) */
  let turnAll: string[] = [];
  let lastPrompt = "";
  let limitRejected = false;
  let limitReset: number | null = null;
  let lastActive = Date.now();
  /** 아직 결과가 안 온 도구 호출(멈춘 명령 찾기) · 멈추게 한 명령 */
  const openTools = new Map<string, OpenTool>();
  let unsticking: { tool: OpenTool; at: number; min: number; killed: boolean } | null = null;
  let released = false;
  /** 재운 시점의 lastActive(그 뒤 활동하면 달라져 다시 재울 수 있다) */
  let sleptAt = 0;
  const unsub: (() => void)[] = [];
  // 스트림 조각은 모아서 처리(조각마다 화면을 다시 그리면 버벅인다). 다시 시작한 뒤 남은 옛 조각은 버린다
  const events = batcher<{ gen: number; line: string }>((x) => {
    if (x.gen === gen) onEvent(JSON.parse(x.line));
  });

  // 와이파이 끊김·절전으로 연결 오류가 나면 다시 연결된 뒤 같은 대화로 이어서(그동안 이 에이전트는 일하는 중으로 둔다)
  /** 연결·로그인이 돌아온 뒤 같은 대화로 다시 띄워 끊긴 지점부터 이어서 */
  async function resumeAfterDrop(note: string) {
    if (!state.busy || state.running) return;
    work.note(note);
    try {
      await restart(model);
      await sendRaw(NET_CONTINUE);
    } catch (e) {
      work.error(`이어서 보내지 못했어요: ${e}`);
      finish("");
    }
  }
  const net = createNetRetry({
    note: (t) => work.note(t),
    retry: () => resumeAfterDrop("— 다시 연결됐어요. 같은 대화로 이어서 해요 —"),
  });
  // 로그인이 풀려 멈춘 차례: 다시 로그인되면 이어서(그동안 이 에이전트는 일하는 중으로). 연달아 만료면 로그인을 기다린다
  const auth = deps.auth ?? authWaiter;
  let authCancel: (() => void) | null = null;
  let authTries = 0;
  function cancelAuth() {
    authCancel?.();
    authCancel = null;
  }

  function finish(answer: string, full?: string) {
    state.busy = false;
    lane.onFinish?.(answer, full);
  }

  async function restart(m: string | null) {
    gen += 1;
    state.ready = false;
    adapter.reset();
    await deps.invoke("claude_start", { id: pid, cwd: dir, model: m, permission: perm(), cont: false, resume: session, bare: false, gen, account: rot.id, lean: !!member.lean, effort: eff || null, chrome: o.chrome ? o.chrome() : (member.chrome ?? null), compactWindow: TEAM_COMPACT_WINDOW });
    effNow = eff;
    model = m;
    state.ready = true;
    state.live = true;
  }

  /** 실제로 보내기(압축할 때가 됐으면 먼저 압축하고, 끝나면 이 지시를 보낸다) */
  async function sendRaw(prompt: string) {
    state.running = true;
    turnText = "";
    limitRejected = false;
    if (!compacting && Date.now() >= noCompactUntil && shouldCompact(meter, state.ctxLimit, settings.compactAt)) {
      queued = prompt;
      compacting = true;
      compactOk = false;
      work.note(`— 지난 대화(${fmtTokens(state.ctx)})를 다시 읽는 비용이 압축 비용을 넘어 먼저 압축해요(/compact) —`);
      await deps.invoke("claude_send", { id: pid, text: COMPACT_CMD });
      return;
    }
    await deps.invoke("claude_send", { id: pid, text: prompt });
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

  /** 한도 소진 → 다음 계정으로 같은 대화를 이어서 다시 보낸다 */
  async function switchAccount() {
    const sw = await rot.next(limitReset);
    limitRejected = false;
    if (!sw) {
      waitLimit(async () => {
        await restart(model);
        await sendRaw(lastPrompt);
      });
      return;
    }
    work.failRunning();
    work.note(`🔄 계정 전환: ${sw.from} → ${sw.to} (한도 소진) · 같은 대화로 이어서 다시 보내요`);
    try {
      await restart(model);
      await sendRaw(lastPrompt);
    } catch (e) {
      work.error(`전환 실패: ${e}`);
      finish("");
    }
  }

  function onEvent(ev: any) {
    lastActive = Date.now();
    if (ev.type === "system" && ev.subtype === "background_tasks_changed") state.bg = Array.isArray(ev.tasks) ? ev.tasks.length : 0;
    // 백그라운드 작업이 끝나면 Claude가 스스로 이어서 답한다 — 그동안은 일하는 중으로
    if (!state.running && ev.type === "assistant") state.running = true;
    if (ev.session_id && ev.session_id !== session) {
      const prev = session;
      session = ev.session_id;
      lane.onSession?.(ev.session_id, prev);
    }
    if (ev.type === "system") {
      if (ev.subtype === "init") {
        state.ready = true;
        learnModel(model, ev.model);
      }
      else if (ev.subtype === "compact_boundary") {
        const m = ev.compact_metadata ?? {};
        if (typeof m.post_tokens === "number") state.ctx = m.post_tokens;
        compacted(meter, typeof m.post_tokens === "number" ? m.post_tokens : 0);
        compactOk = true;
        work.note(`— 대화 압축 완료${typeof m.pre_tokens === "number" ? `: ${fmtTokens(m.pre_tokens)} → ${fmtTokens(m.post_tokens ?? 0)}` : ""} —`);
        // 일 도중 Claude가 스스로 압축함(앱이 보낸 /compact가 아님) — 역할 안내가 요약에서 빠졌을 수 있다
        if (!compacting) lane.onAutoCompacted?.();
      }
      return;
    }
    if (!ev.parent_tool_use_id && (ev.type === "assistant" || ev.type === "user") && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c?.type === "tool_use" && c.id) openTools.set(c.id, { id: c.id, name: c.name ?? "", input: c.input ?? {}, at: Date.now() });
        else if (c?.type === "tool_result" && c.tool_use_id) openTools.delete(c.tool_use_id);
      }
    }
    if (ev.type === "assistant" && !ev.parent_tool_use_id) {
      const u = ev.message?.usage;
      if (u) state.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "text" || !c.text) continue;
        turnText = c.text;
        turnAll.push(c.text);
      }
    }
    if (ev.type === "result") {
      state.running = false;
      work.ui.status = "";
      openTools.clear();
      // 멈추게 한 차례의 끝(오류)은 지시의 끝이 아니다 — 같은 대화로 이어서 하라고 보낸다
      if (unsticking) {
        const u = unsticking;
        unsticking = null;
        state.quietMin = 0;
        turnText = "";
        turnAll = [];
        void sendRaw(unstuckPrompt(u.tool, u.min)).catch((e) => {
          work.error(`이어서 보내지 못했어요: ${e}`);
          if (state.busy) finish("");
        });
        return;
      }
      if (ev.is_error && !compacting && state.busy && limitHit(limitRejected, ev.result)) {
        turnText = "";
        void switchAccount();
        return;
      }
      if (ev.is_error && !compacting && state.busy && authKind(ev.result)) {
        turnText = "";
        work.failRunning();
        const kind = authKind(ev.result) === "expired" && authTries < 2 ? "expired" : "login";
        authTries += 1;
        work.note(kind === "login" ? "— Claude 로그인이 풀렸어요. 열린 로그인 창에서 다시 로그인하면 같은 대화로 이어서 할게요 —" : "— 로그인 토큰이 만료돼 잠시 뒤 다시 시작해서 이어서 할게요 —");
        cancelAuth();
        authCancel = auth.wait(rot.id, kind, async () => {
          authCancel = null;
          await resumeAfterDrop("— 로그인이 돌아왔어요. 같은 대화로 이어서 해요 —");
        });
        return;
      }
      if (ev.is_error && !compacting && state.busy && isNetError(ev.result) && net.fail()) {
        // 이번 차례에 쓴 글(turnAll)은 남겨 둔다 — 이어서 끝낸 뒤 인계를 함께 찾는다
        turnText = "";
        work.failRunning();
        return;
      }
      const wins = Object.values<any>(ev.modelUsage ?? {}).map((m) => m?.contextWindow || 0);
      if (wins.length && Math.max(...wins) > 0) state.ctxLimit = Math.max(...wins);
      if (compacting) {
        compacting = false;
        if (ev.is_error || !compactOk) {
          noCompactUntil = Date.now() + COMPACT_PAUSE_MS;
          work.error(`압축 실패: ${typeof ev.result === "string" && ev.result ? ev.result : "대화를 줄이지 못했어요"} — 30분 동안 자동 압축을 쉬고 지시를 그대로 보내요`);
        }
        const q = queued;
        queued = null;
        if (q && state.busy) {
          const q2 = lane.onCompacted?.(q) ?? q;
          void sendRaw(q2).catch((e) => {
            work.error(`전송 실패: ${e}`);
            finish("");
          });
        }
        return;
      }
      const u = ev.usage;
      if (u) observe(meter, state.ctx, u.cache_read_input_tokens || 0, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), W.write);
      if (ev.is_error && state.busy) work.error(ev.result ?? "오류");
      const ans = typeof ev.result === "string" ? ev.result : turnText;
      const full = turnAll.join("\n\n") || ans;
      turnText = "";
      turnAll = [];
      // 우리가 보낸 지시의 끝은 onFinish, 백그라운드 작업이 끝나 스스로 이어 답한 차례는 onLate(인계를 넘기게)
      if (state.busy && !ev.is_error) {
        net.ok();
        authTries = 0;
      }
      if (state.busy) finish(ans, full);
      else if (full.trim() && !ev.is_error) lane.onLate?.(full);
      return;
    }
    if (ev.type === "rate_limit_event") {
      rot.note(fromClaudeEvent(ev));
      // 거절 신호는 다시 허용(allowed) 신호가 오면 푼다 — 남아 있으면 다음 오류까지 소진으로 본다
      limitRejected = ev.rate_limit_info?.status === "rejected";
      if (limitRejected) limitReset = rejectResetS(ev.rate_limit_info);
      return;
    }
    adapter.handle(ev);
  }

  /** 멈춘 명령 찾기(30초마다 tick에서): 제한 + 여유를 넘기고 조용하면 멈추게 하고, 1분 안에 안 먹히면 그 명령이 띄운 프로그램을 끈다 */
  function watch() {
    const now = Date.now();
    const v = stuckCheck([...openTools.values()], lastActive, now, state.running);
    if (state.quietMin !== v.quietMin) state.quietMin = v.quietMin;
    if (unsticking) {
      if (!unsticking.killed && now - unsticking.at > 60_000) {
        unsticking.killed = true;
        work.note("— 멈춤 요청이 먹히지 않아 그 명령이 띄운 프로그램을 꺼요 —");
        void deps.invoke("claude_kill_since", { id: pid, since: unsticking.tool.at - 2_000 }).catch(() => {});
      }
      return;
    }
    if (!v.unstick) return;
    const min = Math.max(1, Math.floor((now - v.unstick.at) / 60_000));
    unsticking = { tool: v.unstick, at: now, min, killed: false };
    const cmd = typeof v.unstick.input.command === "string" ? v.unstick.input.command : v.unstick.name;
    work.note(`⚠ ${min}분째 끝나지 않고 출력도 없는 명령을 멈추고 이어서 하게 해요: ${cmd.replace(/\s+/g, " ").slice(0, 120)}`);
    lane.onUnstuck?.(cmd);
    void deps.invoke("claude_interrupt", { id: pid }).catch(() => {});
  }

  const lane: Lane = {
    member,
    work,
    state,
    pid,
    sessionId: () => session,
    tag: () => `w${member.id}${gen}`,
    onFinish: null,
    onLate: null,
    onSession: null,
    onCompacted: null,
    onAutoCompacted: null,
    onUnstuck: null,
    onLimitOut: null,

    async init() {
      unsub.push(
        await deps.listen("claude-event", (e) => {
          if (e.payload.id !== pid || e.payload.gen !== gen) return;
          events.push({ gen: e.payload.gen, line: e.payload.line });
        }),
        await deps.listen("claude-stderr", (e) => {
          if (e.payload.id !== pid || e.payload.gen !== gen || !e.payload.line.trim()) return;
          events.flush();
          work.error(e.payload.line);
        }),
        await deps.listen("claude-exit", (e) => {
          if (e.payload.id !== pid || e.payload.gen !== gen) return;
          events.flush();
          state.ready = false;
          state.running = false;
          state.bg = 0;
          state.live = false;
          work.error("Claude 세션이 종료됐어요");
          if (state.busy) finish("");
        }),
      );
    },

    async start(pick?: string | null) {
      const none = { sessionId: null, messages: [] as { role: string; text: string }[], ctx: 0 };
      const past =
        pick === null
          ? none
          : ((await deps.invoke("claude_transcript", { cwd: dir, session: pick ?? (member.resume || null), limit: 20 }).catch(() => none)) ?? none);
      const prev = session;
      session = past.sessionId;
      if (pick !== undefined) lane.onSession?.(session ?? "", prev);
      else if (session && session !== member.resume) lane.onSession?.(session, null);
      if (past.ctx) state.ctx = meter.ctx = past.ctx;
      let shown = 0;
      past.messages.forEach((p: { role: string; text: string }, i: number) => {
        if (isCompactSummary(p.text)) return work.note("— 여기서 대화가 압축됨 —");
        const t = p.role === "assistant" ? p.text : userText(p.text);
        if (t === null) return; // 작업 알림 같은 내부 메시지
        shown++;
        if (p.role === "assistant") work.aiSet(`h${i}`, t);
        else work.user(t);
      });
      state.memory = session ? `이전 대화 ${shown}개` : "새 대화";
      if (session) work.note("— 여기까지 이 폴더에서 Claude와 나눈 지난 대화 —");
      gen += 1;
      try {
        await rot.pick();
        // 팀원은 일을 받을 때 띄운다 — 앱을 켤 때 쉬는 팀원까지 수십 개를 한꺼번에 띄우면 메모리(커밋)를 다 쓴다.
        // 첫 지시 때 '오래 쉬어서 끈 것'과 같은 길로 같은 대화를 이어 띄운다(아직 한 번도 안 띄워 서버 캐시 손해도 없다)
        if (o.lazy && !member.lead) {
          released = true;
          state.ready = true;
          return;
        }
        model = mset === AUTO ? null : mset;
        await deps.invoke("claude_start", { id: pid, cwd: dir, model, permission: perm(), cont: false, resume: session, bare: false, gen, account: rot.id, lean: !!member.lean, effort: eff || null, chrome: o.chrome ? o.chrome() : (member.chrome ?? null), compactWindow: TEAM_COMPACT_WINDOW });
        effNow = eff;
        state.ready = true;
        state.live = true;
      } catch (e) {
        work.error(`Claude 시작 실패: ${e}`);
        state.memory = "시작 실패";
      }
    },

    async send(prompt: string, text: string) {
      net.cancel();
      cancelAuth();
      state.busy = true;
      lastPrompt = prompt;
      lastActive = Date.now();
      const want = laneModel("claude", mset, text);
      try {
        // 오래 쉬어서 껐으면 같은 대화로 다시 띄운다(이번 지시의 모델로)
        if (released) {
          released = false;
          await restart(want);
        }
        // 👤 계정 패널에서 전환했으면 이번 지시부터 그 계정으로
        const sw = await rot.sync();
        if (sw) {
          work.note(`🔄 계정 전환: ${sw.from} → ${sw.to} · 같은 대화로 이어서`);
          if (want === model) await restart(model);
        }
        if (want !== model) {
          work.note(`— 모델: ${modelLabel("claude", want)}${mset === AUTO ? " (자동)" : ""} · 같은 대화로 이어서 재시작 —`);
          await restart(want);
        } else if (eff !== effNow) {
          work.note(`— 생각 깊이: ${effortLabel("claude", eff)} · 같은 대화로 이어서 재시작 —`);
          await restart(model);
        }
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
      lastActive = Date.now();
      void deps.invoke("claude_send", { id: pid, text }).catch((e) => work.error(`전송 실패: ${e}`));
    },

    async stop() {
      net.cancel();
      cancelAuth();
      cancelLimitWait();
      await deps.invoke("claude_interrupt", { id: pid }).catch(() => {});
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
      gen += 1; // 끄면서 나오는 종료 이벤트는 무시
      await deps.invoke("claude_stop", { id: pid }).catch(() => {});
      state.live = false;
      adapter.reset();
      state.bg = 0;
      released = false;
      lastActive = Date.now();
      meter.ctx = 0;
      await lane.start(sel);
    },

    setEffort(e: string) {
      eff = e;
      member.effort = e || undefined;
    },

    setModel(m: string) {
      mset = m;
      member.model = m;
    },

    tick() {
      watch();
      // 스스로 이어 일하는 중(running)도 일하는 중 — 재우면 돌던 명령까지 얼어 버린다
      if (released || state.busy || state.running || compacting || !state.ready) return;
      const now = Date.now();
      if (sleptAt !== lastActive && sleepDue(lastActive, now, settings, state.bg)) {
        sleptAt = lastActive;
        deps.invoke("claude_sleep", { id: pid }).catch(() => {});
      }
      if (!releaseDue(lastActive, now, settings, state.bg)) return;
      released = true;
      state.live = false;
      gen += 1; // 끄면서 나오는 종료 이벤트는 무시
      deps.invoke("claude_stop", { id: pid }).catch(() => {});
      work.note(RELEASE_NOTE);
    },

    dispose() {
      net.cancel();
      cancelAuth();
      cancelLimitWait();
      events.dispose();
      unsub.forEach((u) => u());
      deps.invoke("claude_stop", { id: pid }).catch(() => {});
    },
  };
  return lane;
}
