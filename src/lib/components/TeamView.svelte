<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 👥 팀 탭: 사용자는 팀장하고만 대화한다. 팀장이 요청을 나눠 에이전트를 만들거나 역할을 살짝 바꿔 맡기고,
  // 큰 배치·기획 결과는 확인을 받은 뒤 진행하며, 결과를 모아 보고한다. 일하는 에이전트는 사용자에게 말하지 않고
  // "### 인계"만 남기며 화면에는 상태 카드로만 보인다. 에이전트끼리는 인계 메모로 맞추고, 다음 배치는 팀장이 정한다.
  import { onMount, onDestroy, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { setWorking, setBackground } from "$lib/stats.svelte";
  import { applyFsChanges } from "$lib/work/fsChanges";
  import { tauriIO } from "$lib/work/io";
  import { fileKey } from "$lib/work/fileList";
  import { notify, titleFor } from "$lib/notify";
  import { registerTab, changedSince, fills, joinInput } from "$lib/remoteBus.svelte";
  import { matchOwns } from "$lib/collab/ownership";
  import { settings } from "$lib/settings.svelte";
  import { setBusy } from "$lib/accounts.svelte";
  import type { FsChange } from "$lib/work/types";
  import SessionPicker from "./SessionPicker.svelte";
  import AddAgent from "./AddAgent.svelte";
  import LeadChat from "./team/LeadChat.svelte";
  import AgentCard from "./team/AgentCard.svelte";
  import Icon from "./Icon.svelte";
  import { DEFAULT_ROLES, detectAreas, type Areas, type Roles } from "$lib/pair/route";
  import { followupLimit, isNoShare, scopeLimited } from "$lib/pair/rounds";
  import { fromPair, routeTeam, teamPrompt, teamIntro, teamKey, memosFrom, trespassTeam, splitByCap, hqMax, applyRoleEdits, kickoffFrom, isWorker, overlapsFrom, routeExtra, type Member, type RoleEdit, type Kickoff } from "$lib/team/team";
  import { parseLeadReply, leadGate, firstStage, migrateTeam, leadPrompt, addLeadNote, planActions, resolveAssign, mergeTurnText, type LeadAction, type LeadTurn } from "$lib/team/leadAgent";
  import { resumeTurns, flightEmpty, type Flight } from "$lib/team/flight";
  import { confirmFrom, mergeConfirm, gitConfirm, branchConfirm, prConfirm, proposeBranch, loadChat, saveChat, openConfirm, supersede, type ChatMsg, type ConfirmReq } from "$lib/team/leadChat";
  import { agentState, activityLine, lastHandoff, STATE_LABEL, type AgentState } from "$lib/team/agentStatus";
  import { MODES, teamMode, modelForMode, canSwitchMode, recoverModel, type TeamMode } from "$lib/team/mode";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { nightActive, nightAutoApproves, noteResult, startNight, NIGHT_HOURS } from "$lib/team/night";
  import { createClaudeLane } from "$lib/team/claudeLane.svelte";
  import { createCodexLane } from "$lib/team/codexLane.svelte";
  import type { Lane } from "$lib/team/lane";
  import { syncNote } from "$lib/team/teamSync";
  import { register as registerStorage } from "$lib/work/storageRegistry";
  import { isStopped } from "$lib/work/storageRun.svelte";
  import { plainTeam } from "$lib/team/clone.svelte";
  import { scanDirs as scanTree, readDir } from "$lib/team/scan";

  let { id, cwd = "", team, resume = "", resume2 = "", models, onteam, addOpen = false, onaddshown, kickoff, onkickoff }: {
    id: string;
    cwd?: string;
    /** 저장된 에이전트 구성(없으면 옛 협업 탭 → 두 에이전트) */
    team?: Member[];
    /** 옛 협업 탭에서 이어받을 대화 id·모델 */
    resume?: string;
    resume2?: string;
    models?: { claude?: string; codex?: string };
    /** 에이전트 구성이 바뀌면 탭에 저장 */
    onteam: (m: Member[]) => void;
    /** 처음 열 때 에이전트 추가 창부터(단일 탭에서 바꿨을 때) */
    addOpen?: boolean;
    onaddshown?: () => void;
    /** "목적대로 바로 시작": 열리면 이 목적을 팀장에게(한 번만) */
    kickoff?: Kickoff;
    /** 바로 시작을 꺼냈으면 탭에서 지운다(다시 켜도 또 시작하지 않게) */
    onkickoff?: () => void;
  } = $props();
  let showAdd = $state(untrack(() => addOpen));
  if (untrack(() => addOpen)) untrack(() => onaddshown?.());

  const dir = untrack(() => cwd);
  const io = tauriIO(dir);
  const deps = { invoke: invoke as (cmd: string, args?: any) => Promise<any>, listen: listen as any, io };

  // ---------- 에이전트 ----------
  let members = $state<Member[]>([]);
  let lanes = $state.raw<Lane[]>([]);
  const laneOf = (mid: string) => lanes.find((l) => l.member.id === mid);
  const memberOf = (mid: string) => members.find((m) => m.id === mid)!;
  const persist = () => onteam($state.snapshot(members) as Member[]);
  let lead = $derived(members.find((m) => m.lead));
  /** 운영 방식(팀장 멤버에 저장, 옛 팀은 맥스) */
  let mode = $derived(teamMode(lead));
  let prof = $derived(MODES[mode]);
  /** 밤새 모드 중인지(시각은 30초마다 다시 본다) */
  let nowTick = $state(Date.now());
  let night = $derived(nightActive(lead?.night, nowTick));
  const nightOn = () => nightActive(lead?.night, Date.now());
  function startNightMode(hours = NIGHT_HOURS) {
    if (!lead) return;
    lead.night = startNight(Date.now(), hours);
    persist();
    nowTick = Date.now();
    note(`밤새 모드: ${hours}시간 동안 확인 카드(배치·역할·후속)를 자동 승인하고 합치기도 바로 해요. 기획 확인·합치기 대기·충돌은 아침까지 남겨 둬요`);
  }
  /** 밤새 모드 끝내기 — 사람이 끄지 않았으면(시간·실패) 팀장에게 아침 보고를 받는다 */
  function endNightMode(why: string, report: boolean) {
    if (!lead?.night) return;
    lead.night = undefined;
    persist();
    nowTick = Date.now();
    note(`밤새 모드 끝 — ${why}`);
    notify({ kind: "done", title: `${titleFor(id, "팀")} · 밤새 모드 끝`, body: why, tabId: id });
    if (report) askLead({ kind: "confirmed", text: `밤새 모드가 끝났다(${why}). 새 배치는 내지 말고, 밤새 한 일 · 합친 것 · 남은 것 · 사용자 확인이 필요한 것을 짧게 정리해 보고하라.` });
  }
  /** 브라우저를 쓸지: 팀장은 안 씀, 라이트는 모두 안 씀, 맥스는 팀장이 chrome:true로 만든 역할만 */
  const chromeFor = (m: Member, md: TeamMode) => !m.lead && md === "max" && m.chrome === true;
  /** 운영 방식 바꾸기: 팀장 모델·생각과 역할별 브라우저(다음 시작부터) */
  async function setMode(md: TeamMode) {
    if (!lead || md === mode) return;
    if (!canSwitchMode(mode, md)) return note("맥스 팀은 라이트로 바꿀 수 없어요 — 라이트는 새 팀으로 만들어 주세요");
    const ok = await ask("맥스로 바꾸면 이 팀은 다시 라이트로 돌릴 수 없어요.\n라이트 때문에 낮아졌던 에이전트 모델은 원래대로 돌아가요. 바꿀까요?", { title: "맥스로 바꾸기", kind: "warning", okLabel: "맥스로 바꾸기", cancelLabel: "그대로 두기" }).catch(() => false);
    if (!ok || !lead || mode !== "lite") return;
    lead.mode = md;
    const p = MODES[md];
    lead.model = p.leadModel;
    lead.effort = p.leadEffort;
    const L = leadLane();
    L?.setModel(p.leadModel);
    L?.setEffort(p.leadEffort);
    leadSent = ""; // 규칙(운영 방식 줄)을 다시
    // 이미 있는 에이전트도 그 운영 방식의 모델 등급까지(라이트면 Opus·Fable·자동 → Sonnet 등, 원래 모델은 기억).
    // 맥스로 돌아오면 기억한 원래 모델로 되돌린다. 다음 지시 때 같은 대화로 다시 시작
    for (const w of members.filter((x) => !x.lead)) {
      const next = modelForMode(w.cli, w.model, w.maxModel, p.maxTier);
      w.maxModel = next.maxModel;
      if (next.model !== w.model) {
        laneOf(w.id)?.setModel(next.model);
        w.model = next.model;
      }
      // 브라우저도 다음 시작부터 운영 방식대로 — 모델을 바꾼 에이전트는 다음 지시 때 다시 시작하며 바로 반영
    }
    persist();
    note(`운영 방식: ${p.label} — 팀장 ${p.leadModel}·생각 ${p.leadEffort}, ${Number.isFinite(p.cap) ? `인원 최대 ${p.cap}명` : "인원 제한 없음"}${md === "lite" ? ", 최상위 모델·브라우저는 쓰지 않아요" : ", 합치기 전 검증"} (다음 지시부터)`);
  }
  const leadLane = () => (lead ? laneOf(lead.id) : undefined);

  /**
   * 예전(원래 모델을 기억하기 전)에 라이트로 낮아진 모델 되돌리기 — 한 팀에 한 번.
   * 처음 라이트로 바꾼 시각 전에 각 에이전트가 실제로 쓴 모델을 대화 기록에서 찾아, 더 높았으면
   * 맥스 팀은 그 모델로 되돌리고 라이트 팀은 기억만 한다(맥스로 바꿀 때 되돌린다). 화면을 띄우기 전에(레인을 만들기 전) 한다
   */
  async function recoverModels() {
    if (!lead || lead.modelsRecovered) return;
    const at = chat.find((m) => m.role === "note" && m.text.startsWith("운영 방식: 라이트"))?.at;
    const back: string[] = [];
    if (at) {
      for (const w of members.filter((x) => !x.lead && !x.maxModel && x.resume)) {
        const used = await invoke<string | null>("session_model_before", { cli: w.cli, id: w.resume, before: at }).catch(() => null);
        const patch = recoverModel(w.cli, w.model, used, mode);
        if (!patch) continue;
        if (patch.model) {
          w.model = patch.model;
          back.push(w.name);
        }
        if (patch.maxModel) w.maxModel = patch.maxModel;
      }
    }
    lead.modelsRecovered = true;
    persist();
    if (back.length) note(`라이트 때문에 낮아졌던 모델을 원래대로 되돌렸어요: ${back.join(" · ")}`);
  }

  // 에이전트별 상태(팀 지시 중 / @이름으로 직접 시킨 일 중)
  const inCmd = $state<Record<string, boolean>>({});
  const solo = $state<Record<string, boolean>>({});
  const soloStart: Record<string, number> = {};
  const working = (mid: string) => !!inCmd[mid] || !!solo[mid];
  /** 팀장이 답을 만드는 중 */
  let leadWorking = $state(false);
  /** 팀장이 낸 일을 시작하려고 새 에이전트·준비를 기다리는 중 */
  let executing = $state(false);
  let cmdOn = $derived(Object.values(inCmd).some(Boolean));
  let busy = $derived(cmdOn || Object.values(solo).some(Boolean) || leadWorking || executing);
  /** 일하는 에이전트(팀장 뺌) */
  let workers = $derived(members.filter(isWorker));
  let anyBg = $derived(lanes.some((l) => l.state.bg > 0));
  /** 지시 없이 스스로 이어 일하는 에이전트(백그라운드 테스트·빌드가 끝나 결과를 보는 중) — 이때 '유휴'로 보였다 */
  let selfRunning = $derived(lanes.some((l) => l.state.running && !l.state.busy));
  $effect(() => setWorking(id, busy || selfRunning));
  $effect(() => setBackground(id, !busy && anyBg));
  $effect(() => setBusy(id, busy));

  /** 이 에이전트가 일하는 폴더(자기 브랜치 워크트리, 없으면 원래 폴더) */
  const dirOf = (m: Member) => (!m.lead && m.wt) || dir;
  function makeLane(m: Member): Lane {
    const ldir = dirOf(m);
    const ldeps = ldir === dir ? deps : { ...deps, io: tauriIO(ldir) };
    const lane = (m.cli === "claude" ? createClaudeLane : createCodexLane)({ tabId: id, dir: ldir, member: m, deps: ldeps, settings, lazy: true, chrome: () => chromeFor(m, teamMode(members.find((x) => x.lead))) });
    lane.onFinish = (ans, full) => (m.lead ? onLead(full ?? ans) : finishTurn(m.id, ans, full));
    // 백그라운드 작업이 끝나 스스로 이어 쓴 마무리에도 인계가 있으면 쌓는다(팀장의 이어 쓴 글은 넘기지 않음)
    lane.onLate = (full) => !m.lead && lateAnswer(m.id, full);
    lane.onSession = (sid, prev) => {
      if (prev) {
        if (m.lead) leadSent = "";
        else roleSent[m.id] = ""; // 다른 대화로 바뀜 → 다음 지시에 안내를 다시
      }
      m.resume = sid || undefined;
      persist();
      // 앱이 만든 Codex 대화 — 일회용 기록 정리에서 지우지 않게
      if (sid && m.cli === "codex") void invoke("storage_codex_own", { ids: [sid] }).catch(() => {});
    };
    lane.onCompacted = (q) => {
      // 압축하면 안내가 요약에서 빠질 수 있다 → 다음에 안내를 다시 붙인다
      if (m.lead) {
        leadSent = "";
        return q;
      }
      roleSent[m.id] = teamKey(members);
      return q.includes("[팀 협업]") ? q : `${teamIntro(m, members)}\n\n${q}`;
    };
    lane.onUnstuck = (cmd) => note(`⚠ ${m.name}: 제한 시간을 한참 넘기고 출력도 없던 명령을 멈추고 이어서 하게 했어요 — ${cmd.replace(/\s+/g, " ").slice(0, 80)}`);
    lane.onAutoCompacted = () => {
      if (m.lead) leadSent = "";
      else roleSent[m.id] = "";
    };
    // 한도가 다 됐고 바꿀 계정도 없음: 레인이 차례를 끝내지 않고 풀릴 때까지 기다렸다 같은 지시를 다시 보낸다 — 여기서는 알리기만
    lane.onLimitOut = () => notice("limit");
    return lane;
  }

  async function addLane(m: Member) {
    const lane = makeLane(m);
    lanes = [...lanes, lane];
    await lane.init();
    // 새로 추가한 에이전트는 이 폴더의 최근 대화(다른 에이전트의 대화일 수도)를 이어받지 않고 새 대화로 시작 — 이을 대화를 정해 왔으면 그것
    await lane.start(m.resume ? undefined : null);
  }

  /** 에이전트 추가 — 이름은 이미 겹치지 않게 정해져 온다. 추가한 에이전트 id들을 돌려준다 */
  export async function addMembers(drafts: (Omit<Member, "id"> & { task?: string })[]): Promise<string[]> {
    let n = members.length;
    const ids: string[] = [];
    for (const { task: _task, ...d } of drafts) {
      let mid = `m${++n}`;
      while (members.some((x) => x.id === mid)) mid = `m${++n}`;
      const m = { ...d, id: mid } as Member;
      members.push(m);
      const live = members.find((x) => x.id === mid)!;
      persist();
      await addLane(live);
      ids.push(mid);
    }
    return ids;
  }

  /** 에이전트 빼기(일하는 에이전트·팀장은 못 뺌). 뺀 에이전트의 대화는 남아 있어 대화 고르기로 다시 이을 수 있다 */
  function removeMember(mid: string) {
    if (working(mid) || memberOf(mid)?.lead) return;
    laneOf(mid)?.dispose();
    lanes = lanes.filter((l) => l.member.id !== mid);
    members = members.filter((m) => m.id !== mid);
    delete inCmd[mid];
    delete solo[mid];
    if (openCard === mid) openCard = "";
    persist();
  }

  // ---------- 팀장과의 대화 ----------
  let chat = $state<ChatMsg[]>([]);
  let seq = 0;
  const store = () => (typeof localStorage === "undefined" ? undefined : localStorage);
  /** 이 팀의 대화 기록 id(팀장 멤버에 저장) — 같은 폴더의 팀 탭끼리 섞이지 않게 */
  const chatId = () => lead?.chat ?? "";
  const save = () => saveChat(store(), dir, $state.snapshot(chat) as ChatMsg[], chatId());
  function say(role: ChatMsg["role"], text: string, confirm?: ConfirmReq) {
    // 같은 갈래의 열린 확인 카드가 있으면 닫는다 — 결과가 잇달아 오면 같은 확인이 두 장씩 떠 있었다
    if (confirm) supersede(chat, confirm.kind);
    chat.push({ key: `${Date.now()}-${++seq}`, role, text, at: Date.now(), ...(confirm ? { confirm } : {}) });
    save();
  }
  const note = (text: string) => say("note", text);

  /** 지금 지시(사용자가 팀장에게 한 말 하나)의 흐름 */
  const ctx: { instruction: string; planConfirmed: boolean; rounds: number; mergeTitle?: string; mergeBody?: string } = { instruction: "", planConfirmed: false, rounds: 0 };
  /** 팀장에게 보낸 차례(답이 어느 차례의 답인지)와 그 차례의 지시 글(관문 판단용) */
  let leadTurn: LeadTurn["kind"] | null = null;
  let leadTurnText = "";
  /** 팀장의 마지막 말(폰 @상태) */
  let lastLeadSay = "";
  /** 멈출 때마다 1씩 — 멈추기 전에 시작한 기다림은 멈춘 뒤 이어 가지 않는다 */
  let epoch = 0;
  /** 마지막으로 팀장에게 보낸 차례(한도에 걸리면 기다렸다 다시) */
  let lastLeadAsk: LeadTurn | null = null;
  /** 프로젝트 종류(team_kind) — 엔진 프로젝트면 팀장에게 안내 */
  let projectKind = "other";
  /** 팀장이 바쁠 때 온 결과 차례(끝나면 차례대로) */
  let leadQueue: LeadTurn[] = [];
  /** 팀장에게 규칙을 보낸 팀 구성(바뀌면 다음 차례에 규칙을 다시) */
  let leadSent = "";
  /** "고칠래요"를 누른 뒤 사용자가 보낼 글은 고칠 내용 */
  let revisePending = $state(false);

  const stateOf = (mid: string): AgentState => {
    const L = laneOf(mid);
    const log = L?.work.log ?? [];
    return agentState({
      ready: !!L?.state.ready,
      working: working(mid) || !!L?.state.running,
      queued: waiting.includes(mid) || stages.some((st) => st.includes(mid)),
      error: log.length > 0 && log[log.length - 1].kind === "error",
      bg: (L?.state.bg ?? 0) > 0,
    });
  };

  function askLead(turn: LeadTurn) {
    const L = leadLane();
    // 팀장이 바쁘거나 아직 준비 중이면 차례대로 기다렸다 보낸다(결과를 버리지 않는다)
    if (!lead || !L?.state.ready || leadWorking) {
      leadQueue.push(turn);
      if (lead && !L?.state.ready) note("팀장이 준비되면 이어서 전해요");
      return;
    }
    const key = teamKey(members);
    const full = leadSent !== key;
    leadSent = key;
    leadWorking = true;
    leadTurn = turn.kind;
    leadTurnText = turn.kind === "direct" ? turn.text : ctx.instruction;
    lastLeadAsk = turn;
    const status = Object.fromEntries(workers.map((m) => [m.id, STATE_LABEL[stateOf(m.id)]]));
    L.send(leadPrompt({ turn, members, status, notes: lead.notes ?? [], full, cap: prof.cap, kind: projectKind, mode, mergeAsk: lead.mergeAsk }), turn.text).catch(() => {
      leadSent = "";
      leadWorking = false;
      leadTurn = null;
      note("⚠ 팀장에게 보내지 못했어요");
      const next = leadQueue.shift();
      if (next) askLead(next);
    });
  }

  /** 팀장이 준비되면(시작·다시 시작) 기다리던 차례를 보낸다 */
  $effect(() => {
    const ready = !!leadLane()?.state.ready;
    if (ready) untrack(() => {
      if (!leadWorking && leadQueue.length) askLead(leadQueue.shift()!);
    });
  });

  /** 팀장 오류(시작 실패·세션 종료·한도 등)는 대화에 안내로 — 팀장 기록은 화면에 없으므로 */
  let leadErrSeen = 0;
  $effect(() => {
    const log = leadLane()?.work.log ?? [];
    const n = log.length;
    untrack(() => {
      for (let k = leadErrSeen; k < n; k++) if (log[k].kind === "error") note(`⚠ 팀장: ${log[k].text}`);
      leadErrSeen = n;
    });
  });

  function restartLead() {
    const L = leadLane();
    if (!L || L.state.ready) return;
    note("팀장을 다시 시작해요");
    void L.start(lead?.resume ? undefined : null);
  }

  /** 팀장 답: 말은 대화에, 할 일은 확인을 받거나 바로 실행 */
  function onLead(text: string) {
    // 멈춘 뒤에 늦게 끝난 팀장 답은 실행하지 않는다
    if (!leadWorking && leadTurn === null) return;
    leadWorking = false;
    const turn = leadTurn ?? "user";
    const turnText = leadTurnText;
    leadTurn = null;
    if (!text.trim()) note("⚠ 팀장이 답하지 못했어요");
    const r = parseLeadReply(text);
    const plan = planActions(members, r.actions, prof.cap, prof.maxTier);
    const work = plan.assign.length + plan.creates.length + plan.roles.length > 0;
    // 합치기만 냈으면 바로 합친다. 맡길 일과 함께 냈으면 먼저 합치고 그 일을 맡긴다(mergeThenExecute) —
    // 예전에는 함께 온 합치기를 말없이 버려서, 팀장은 합쳐진 줄 알고 "합친 뒤 이어서"를 맡겼다(3일에 23번)
    const mergeNow = plan.merge && !work;
    if (plan.merge) {
      ctx.mergeTitle = plan.mergeTitle;
      ctx.mergeBody = plan.mergeBody;
    }
    const g = leadGate({ turn, reply: { ...r, actions: work ? r.actions : [] }, instruction: turnText, planConfirmed: ctx.planConfirmed, rounds: ctx.rounds, limit: nightOn() ? Infinity : followupLimit(settings) });
    if (g.limit) note(`후속을 ${followupLimit(settings)}번 다 써서 멈췄어요 — 확인하면 이어서 해요`);
    if (r.say) lastLeadSay = r.say;
    if (g.kind) {
      const c = { ...confirmFrom(r, plan, members, g.kind, `c${Date.now()}`), instruction: ctx.instruction };
      // 기획 관문으로 만든 카드는 팀장 말이 곧 본문이라 말풍선은 비운다
      say("lead", g.kind === "plan" && !r.confirm ? "" : r.say, c);
      notify({ kind: "done", title: `${titleFor(id, "팀")} · 확인 요청`, body: c.title, tabId: id });
      finishRemote(`${r.say}\n\n[확인 요청] ${c.title} — PC에서 확인해 주세요`);
      // 밤새 모드: 배치·기타 확인은 사람 대신 승인(기획 확인은 아침까지)
      // 사용자가 범위를 정한 지시("~만", "~까지만")는 밤새 모드여도 넘지 않는다
      if (nightOn() && nightAutoApproves(c.kind) && !scopeLimited(ctx.instruction)) {
        note(`밤새 모드: "${c.title}" 자동 승인`);
        queueMicrotask(() => onConfirm(c.id, true));
      }
    } else if (r.say) say("lead", r.say);
    for (const e of plan.errors) note(`⚠ ${e}`);
    const after = turn === "results" || turn === "direct";
    if (!g.kind && work) {
      if (after) ctx.rounds += 1;
      let acts = r.actions;
      if (g.firstStageOnly) {
        const st = firstStage(acts);
        acts = st.now;
        if (st.later.length) note("기획을 먼저 해요 — 다음 단계는 기획을 확인한 뒤에 맡겨요");
      }
      void (plan.merge ? mergeThenExecute(acts) : execute(acts));
    } else if (!g.kind && !work && after && !cmdOn) {
      notice("done", r.say);
      finishRemote(r.say || "(팀장 보고 없음)");
    }
    // 밤새 모드: 결과·합치기 차례에 팀장이 더 맡길 일도 합칠 것도 없다고 하면 끝(아침 보고는 이 답이 곧 보고)
    if (nightOn() && !g.kind && !work && !plan.merge && (after || turn === "merge") && !cmdOn) endNightMode("팀장이 맡길 일을 다 끝냈어요", false);
    if (!g.kind && mergeNow) void requestMerge();
    const next = leadQueue.shift();
    if (next) askLead(next);
  }

  /** 팀장이 낸 일: 만들기 → 역할 바꾸기 → 맡기기 */
  /** started: 일을 시작함 · held: git 확인 카드로 보류(확인하면 그 카드가 다시 실행) · none: 못 함 */
  type Exec = "started" | "held" | "none";
  /** 맡기려고 준비를 기다리는 에이전트(새로 켠 직후 등) — 이때 앱이 꺼지면 이 일이 남지 않아 다시 켜도 이어 하지 못했다 */
  let execPending: string[] = [];
  async function execute(actions: LeadAction[]): Promise<Exec> {
    const my = epoch;
    executing = true;
    try {
      return await executeInner(actions, my);
    } finally {
      executing = false;
      execPending = [];
    }
  }
  async function executeInner(actions: LeadAction[], my: number): Promise<Exec> {
    const plan = planActions(members, actions, prof.cap, prof.maxTier);
    if (plan.creates.length) {
      await addMembers(plan.creates);
      note(`새 에이전트: ${plan.creates.map((c) => c.name).join(" · ")}`);
    }
    for (const r of plan.roles) {
      const m = members.find((x) => x.id === r.id);
      if (!m) continue;
      if (r.purpose !== undefined) m.purpose = r.purpose;
      if (r.areas !== undefined) m.areas = r.areas;
      if (r.chrome !== undefined) m.chrome = r.chrome;
      // 팀장이 일에 맞춰 모델·생각을 바꿈 — 다음 일부터 그 모델로(레인이 보낼 때 맞춰 다시 띄운다)
      if (r.model !== undefined) {
        laneOf(m.id)?.setModel(r.model);
        m.maxModel = r.maxModel;
      }
      if (r.effort !== undefined) laneOf(m.id)?.setEffort(r.effort);
      note(`${r.model !== undefined || r.effort !== undefined ? "모델 조정" : "역할 조정"} · ${r.note}`);
    }
    if (plan.roles.length) persist(); // teamKey가 바뀌어 다음 지시에 안내가 다시 붙는다
    const a = resolveAssign(members, plan.assign);
    for (const e of a.errors) note(`⚠ ${e}`);
    if (!a.ids.length) return "none";
    execPending = a.ids;
    // 새로 만든 에이전트가 준비될 때까지(최대 3분) — 그 사이 멈추면 시작하지 않는다
    const until = Date.now() + 180_000;
    while (Date.now() < until && epoch === my && a.ids.some((x) => !laneOf(x)?.state.ready)) await new Promise((res) => setTimeout(res, 500));
    if (epoch !== my) return "none";
    const ready = a.ids.filter((x) => laneOf(x)?.state.ready);
    const late = a.ids.filter((x) => !ready.includes(x)).map((x) => memberOf(x)?.name ?? x);
    if (late.length) note(`⚠ ${late.join("·")}이(가) 준비되지 않아 빼고 시작해요`);
    if (!ready.length) {
      note("에이전트가 준비되지 않아 시작하지 못했어요");
      return "none";
    }
    // 에이전트마다 자기 브랜치에서(처음이면 작업 폴더를 만들어 옮긴다). git 저장소가 아니면 한 번 묻고 멈춘다
    // (카드를 다시 실행할 때 이미 만든 에이전트를 또 만들지 않게 create는 뺀다)
    const again = actions.filter((x) => x.type !== "create" || !members.some((m) => m.name.toLowerCase() === x.name.toLowerCase()));
    if (!(await ensureBranches(ready, again))) return "held";
    if (epoch !== my) return "none";
    dispatch(ready.filter((x) => laneOf(x)?.state.ready), ctx.instruction, a.preset, a.order);
    return "started";
  }

  // ---------- 자기 브랜치 ----------
  /** 이번에 맡길 에이전트들이 자기 브랜치에서 일하게. 계속 진행해도 되면 true(git 확인 카드를 띄웠으면 false) */
  async function ensureBranches(ids: string[], actions: LeadAction[]): Promise<boolean> {
    if (!lead?.chat || lead.branchOff) return true;
    const want = ids.filter((x) => {
      const m = memberOf(x);
      return m && !m.home && !m.wt && !working(x);
    });
    if (!want.length) return true;
    const st = await invoke<{ is_git: boolean; has_commit: boolean; dirty: boolean; prefix: string }>("team_repo", { repo: dir }).catch(() => null);
    if (!st) return true; // 확인을 못 하면 같은 폴더에서
    if (st.prefix) {
      // 저장소의 하위 폴더(모노레포 등): 작업 폴더가 저장소 전체라 담당 경로가 어긋난다 → 같은 폴더에서
      lead.branchOff = true;
      persist();
      note(`이 폴더는 저장소의 하위 폴더(${st.prefix})라 브랜치 없이 같은 폴더에서 일해요`);
      return true;
    }
    if (!st.is_git || !st.has_commit) {
      if (nightOn()) {
        note("밤새 모드: git 저장소가 아니라 이번엔 같은 폴더에서 일해요(만들지는 아침에 물어볼게요)");
        return true;
      }
      const c = gitConfirm(`g${Date.now()}`, actions, ctx.instruction);
      say("lead", "", c);
      notify({ kind: "done", title: `${titleFor(id, "팀")} · 확인 요청`, body: c.title, tabId: id });
      return false;
    }
    if (st.dirty) {
      // 원래 폴더에 커밋 안 한 변경이 있으면 지금 옮기면 에이전트가 그 내용을 못 본다 → 이번엔 같은 폴더에서
      note("원래 폴더에 커밋 안 한 변경이 있어 이번엔 같은 폴더에서 일해요 — 커밋하면 다음 일부터 자기 브랜치로 옮겨요");
      return true;
    }
    for (const x of want) await moveToBranch(x);
    return true;
  }

  /** 에이전트를 자기 브랜치 작업 폴더로 옮긴다 — 대화는 같은 id로 이어 쓴다(옮기지 못하면 원래 폴더에서 계속) */
  async function moveToBranch(mid: string) {
    const m = memberOf(mid);
    const L = laneOf(mid);
    const busyNow = () => working(mid) || !!L?.state.running || (L?.state.bg ?? 0) > 0;
    if (!m || !L || !lead?.chat || busyNow()) return;
    let wt: string;
    try {
      wt = await invoke<string>("team_wt", { repo: dir, team: lead.chat, member: mid });
    } catch (e) {
      return note(`⚠ ${m.name}: 브랜치를 만들지 못해 원래 폴더에서 일해요 (${e})`);
    }
    if (m.cli === "claude" && m.resume) {
      const ok = await invoke<boolean>("claude_session_copy", { fromCwd: dir, toCwd: wt, id: m.resume }).catch(() => false);
      if (!ok) return note(`⚠ ${m.name}: 대화를 옮기지 못해 원래 폴더에서 계속 일해요`);
    }
    if (busyNow() || laneOf(mid) !== L) return; // 기다리는 사이 일을 시작했으면 이번엔 그대로
    m.wt = wt;
    persist();
    L.dispose();
    const nl = makeLane(m);
    lanes = lanes.map((l) => (l.member.id === mid ? nl : l));
    roleSent[mid] = ""; // 새 폴더 — 안내부터 다시
    await nl.init();
    await nl.start(m.resume ? undefined : null);
    const until = Date.now() + 120_000;
    while (Date.now() < until && !nl.state.ready) await new Promise((res) => setTimeout(res, 300));
    note(`${m.name}: 자기 브랜치에서 일해요`);
  }

  // ---------- 공유 저장소(남의 GitHub) ----------
  type RemoteInfo = { shared: boolean; remote: boolean; github: boolean; owner?: string; name?: string; login?: string; push: boolean; default: string; forkOrigin?: boolean };
  let remoteCache: { at: number; info: RemoteInfo | null } | null = null;
  /** 원래 폴더의 원격이 남의 저장소인지(10분 동안 기억) */
  async function remoteInfo(): Promise<RemoteInfo | null> {
    if (remoteCache && Date.now() - remoteCache.at < 10 * 60_000) return remoteCache.info;
    const info = await invoke<RemoteInfo>("team_remote", { repo: dir }).catch(() => null);
    remoteCache = { at: Date.now(), info };
    return info;
  }
  const repoLabel = (r: RemoteInfo) => (r.owner ? `${r.owner}/${r.name}` : "원격 저장소");
  /** 합치기 커밋·PR 제목: 팀장이 낸 것, 없으면 지시 첫 줄 */
  const mergeTitle = () => ((ctx.mergeTitle?.trim() || ctx.instruction.trim()).split("\n")[0].trim() || "작업").slice(0, 100);

  // ---------- 합치기 ----------
  type MergeResult = { dirty: boolean; dirty_files?: string[]; merged: string[]; nothing: string[]; conflicts: { member: string; files: string[] }[]; failed: { member: string; error: string }[]; head: string; stashed?: string };
  const branchIds = () => workers.filter((m) => m.wt && !working(m.id)).map((m) => m.id);
  /** 브랜치가 있지만 일하는 중이라 이번 합치기에서 빠지는 에이전트 */
  const busyBranchIds = () => workers.filter((m) => m.wt && working(m.id)).map((m) => m.id);
  const memberName = (x: string) => memberOf(x)?.name ?? x;
  /** 빠진 몫만 있을 때 같은 내용을 팀장에게 되풀이해 알리지 않게(팀장이 또 merge를 내면 다시 알리고 또 내는 되풀이) */
  let mergeToldKey = "";
  /** 다음 일과 함께 낸 합치기: 그 결과를 모아 두는 곳(null이면 바로 팀장에게) */
  let mergeHold: string[] | null = null;
  /** 모아 둔 합치기 결과 — 맡긴 일의 결과와 함께 팀장에게 간다 */
  let mergeNotes: string[] = [];
  /** 합치기 결과를 팀장에게. 다음 일과 함께 낸 합치기면 모아 뒀다가 그 일의 결과와 함께(따로 차례를 주면 팀장이 같은 일을 또 맡긴다) */
  function tellLeadMerge(text: string) {
    if (mergeHold) mergeHold.push(text);
    else askLead({ kind: "merge", text });
  }
  /** 팀장이 merge를 냈는데 합칠 게 없을 때: 빠진 까닭을 팀장에게(한 번만) — 말없이 넘기면 팀장은 합쳐진 줄 알고 기다린다 */
  function tellMergeSkipped(busy: string[], nothing: string[]) {
    const text = mergeTurnText({ merged: [], conflicts: [], failed: [], head: "", busy, nothing }, memberName);
    if (!text) return note("합칠 브랜치가 없어요");
    const key = `${[...busy].sort()}|${[...nothing].sort()}`;
    note(busy.length ? `합치기에서 빠졌어요(일하는 중): ${busy.map(memberName).join(" · ")}` : "합칠 변경이 없어요");
    if (key === mergeToldKey) return;
    mergeToldKey = key;
    tellLeadMerge(text);
  }
  /**
   * 팀장이 합치기와 맡길 일을 한 번에 냈다("합치고 이어서 ○○"): 지금 쉬는 에이전트 몫을 먼저 합치고(다른 브랜치도 맞춘 뒤) 일을 맡긴다.
   * 합치기 확인이 켜져 있으면 카드만 띄우고 일은 그대로 맡긴다(누를 때 그때 쉬는 몫을 합친다).
   * 합친 결과는 맡긴 일의 결과와 함께 팀장에게 — 일을 못 맡겼으면 바로.
   */
  async function mergeThenExecute(acts: LeadAction[]): Promise<Exec> {
    const held: string[] = [];
    mergeHold = held;
    try {
      await requestMerge();
    } finally {
      mergeHold = null;
    }
    const r = await execute(acts);
    if (r === "started") mergeNotes.push(...held);
    else for (const text of held) askLead({ kind: "merge", text });
    return r;
  }
  /** 팀장이 합치기를 냈다: 팀 설정대로 물어보거나 바로 */
  async function requestMerge() {
    if (!lead?.chat) return;
    const ids = branchIds();
    if (!ids.length) return tellMergeSkipped(busyBranchIds(), []);
    if (lead.mergeAsk === false || nightOn()) return doMerge();
    const rows: { name: string; stat: string }[] = [];
    for (const x of ids) {
      const st = await invoke<string>("team_diffstat", { repo: dir, team: lead.chat, member: x }).catch(() => "");
      if (st.trim()) rows.push({ name: memberOf(x)?.name ?? x, stat: st.trim().split("\n").pop() ?? st });
    }
    if (!rows.length) return tellMergeSkipped(busyBranchIds(), ids);
    const c = mergeConfirm(`mg${Date.now()}`, rows, false);
    const ri = await remoteInfo();
    if (ri?.shared) c.body += ` 남의 저장소(${repoLabel(ri)})라 에이전트마다 커밋 하나로 묶어 내 이름으로 넣고, 그 저장소의 검사(hook)·서명 설정을 지켜요. 올리기(push·PR)는 따로 물어봐요.`;
    say("lead", "", c);
    notify({ kind: "done", title: `${titleFor(id, "팀")} · 확인 요청`, body: c.title, tabId: id });
  }
  /** 실제로 합치기 → 다른 에이전트 브랜치 맞추기 → 충돌은 팀장에게 */
  /** stash: 원래 폴더에서 고친 것이 합칠 내용과 겹치면 git stash에 보관하고 합친다(대기 카드에서 누른 경우) */
  async function doMerge(stash = false) {
    if (!lead?.chat) return;
    const team = lead.chat;
    const ids = branchIds();
    const busy = busyBranchIds();
    if (!ids.length) return tellMergeSkipped(busy, []);
    // 남의 저장소: 기본 브랜치(master 등)에 바로 합치지 않는다 — 작업 브랜치를 만들지 먼저 묻는다(밤새 모드여도)
    const ri = await remoteInfo();
    const shared = !!ri?.shared;
    if (ri && shared) {
      const cur = (await invoke<{ branch: string }>("team_repo", { repo: dir }).catch(() => null))?.branch ?? "";
      if (cur && (cur === ri.default || (!ri.default && /^(main|master)$/.test(cur)))) {
        const c = branchConfirm(`br${Date.now()}`, cur, proposeBranch(new Date()), repoLabel(ri));
        say("lead", "", c);
        notify({ kind: "done", title: `${titleFor(id, "팀")} · 확인 요청`, body: c.title, tabId: id });
        return;
      }
    }
    const title = mergeTitle();
    const msg = shared ? title : `팀: ${title}`;
    const r = await invoke<MergeResult>("team_merge", { repo: dir, team, members: ids, message: msg, shared, stash }).catch((e) => {
      note(`⚠ 합치지 못했어요: ${e}`);
      tellLeadMerge(`합치기가 오류로 멈췄다(사용자 브랜치에 들어가지 않았다): ${e}
원래 폴더 상태를 확인할 수 있는 담당이 있으면 확인을 맡기고, 아니면 사용자에게 알려라.`);
      return null;
    });
    if (!r) return;
    if (r.dirty) {
      const files = r.dirty_files ?? [];
      const c = mergeConfirm(`mg${Date.now()}`, [], true, files);
      say("lead", "", c);
      notify({ kind: "done", title: `${titleFor(id, "팀")} · 확인 요청`, body: c.title, tabId: id });
      // 팀장도 알아야 기다리지 않고 풀 수 있다(원래 폴더 담당에게 커밋을 맡기는 등)
      tellLeadMerge(`합치기가 멈춰 사용자 확인을 기다린다(아직 사용자 브랜치에 들어가지 않았다): 원래 폴더에서 고친 파일이 합칠 내용과 겹친다 — ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` 외 ${files.length - 8}개` : ""}.
원래 폴더에서 일하는 담당이 고친 것이면 그 담당에게 커밋하게 한 뒤 다시 merge를 내라. 누가 고쳤는지 모르면 사용자에게 확인 카드를 봐 달라고 알려라.`);
      return;
    }
    mergeToldKey = "";
    if (r.stashed) note(`원래 폴더에서 고친 것은 git stash에 보관했어요(${r.stashed}) — 되돌리려면 git stash pop`);
    const name = (x: string) => memberOf(x)?.name ?? x;
    if (r.merged.length) note(`합쳤어요: ${r.merged.map(name).join(" · ")}${r.head ? ` · ${r.head}` : ""}`);
    else if (!r.conflicts.length && !r.failed.length) note("합칠 변경이 없어요");
    const issues = [...r.conflicts.map((c) => `${name(c.member)}: ${c.files.join(", ") || "(파일 모름)"}`), ...r.failed.map((f) => `${name(f.member)}: ${f.error}`)];
    // 다른 팀원 폴더는 지금 맞추지 않는다 — 일을 받을 때 맞춘다(prepWt). 합친 직후 모두 다시 쓰면 디스크가 몰린다
    if (issues.length) {
      const done = r.merged.length ? `합친 것: ${r.merged.map(name).join(", ")}` : "합친 것 없음";
      note(`⚠ 합치지 못한 몫: ${issues.join(" / ")} — 그 몫은 합치지 않았어요(${done})`);
    }
    // 합친 결과는 늘 팀장에게 — 팀장이 "합쳐지면 이어서 ○○" 하고 기다리다 멈추지 않게(충돌도 함께)
    const text = mergeTurnText({ ...r, busy, nothing: r.merged.length ? [] : r.nothing }, name);
    if (text) tellLeadMerge(r.stashed ? `${text}\n원래 폴더에서 고친 파일은 합치기 전에 git stash에 보관했다(${r.stashed}).` : text);
    // 남의 저장소에 합쳤으면 올리기(push·PR)를 묻는다 — 누를 때만 올린다
    if (ri && shared && ri.remote && r.merged.length) {
      const branch = (await invoke<{ branch: string }>("team_repo", { repo: dir }).catch(() => null))?.branch ?? "";
      const body = ctx.mergeBody?.trim() || `합친 작업: ${r.merged.map(name).join(", ")}`;
      const c = prConfirm(`pr${Date.now()}`, { branch, base: ri.default, repo: repoLabel(ri), fork: ri.github && !ri.push, title, body, github: ri.github });
      say("lead", "", c);
      notify({ kind: "done", title: `${titleFor(id, "팀")} · 확인 요청`, body: c.title, tabId: id });
    }
  }

  /** 올리기 카드를 눌렀다: push하고 PR */
  async function pushPr(c: { branch: string; title: string; body: string; github: boolean }) {
    note("올리는 중…");
    try {
      const r = await invoke<{ pushed: boolean; branch: string; fork: boolean; url: string; existing: boolean }>("team_push_pr", { repo: dir, branch: c.branch, title: c.title, body: c.body, pr: c.github });
      note(r.existing ? `push했어요 — 이미 열린 PR에 반영됐어요${r.url ? `: ${r.url}` : ""}` : r.url ? `PR을 올렸어요: ${r.url}` : `${r.branch}를 올렸어요`);
    } catch (e) {
      note(`⚠ ${e}`);
    }
  }

  // ---------- 한도 기다리기 ----------
  /** (예전) 한도 대기 타이머 — 이제 레인이 스스로 풀릴 때까지 기다린다. 새 지시 때 남은 것을 지운다 */
  let limitTimers: ReturnType<typeof setTimeout>[] = [];

  async function send() {
    const raw = input.trim();
    if (!raw) return;
    input = "";
    say("user", raw);
    // @이름으로 일하는 에이전트를 콕 집으면 그 에이전트에 직접(결과는 팀장이 전한다)
    const r = routeTeam(raw, members);
    const direct = r.ids.filter((x) => isWorker(memberOf(x)));
    if (direct.length && direct.length === r.ids.length) {
      if (!r.text.trim()) return note("무엇을 시킬지 함께 적어 주세요 · 예: @UI 시작 화면 버튼 정리");
      for (const mid of direct) directSend(mid, r.text);
      return;
    }
    if (revisePending && lead) {
      revisePending = false;
      lead.notes = addLeadNote(lead.notes ?? [], raw);
      persist();
      return askLead({ kind: "revise", text: raw });
    }
    // 팀장이 답하는 중이면 그 답이 끝난 뒤 이어서(끼워 넣으면 답이 둘로 갈려 하나를 잃을 수 있다) — 같은 지시의 보충
    if (leadWorking) {
      ctx.instruction = `${ctx.instruction}\n${raw}`;
      note("팀장이 지금 답을 마치면 이어서 전해요");
      return askLead({ kind: "user", text: raw });
    }
    // 새 지시: 한도로 기다리던 옛 일은 취소, 열려 있던 확인 카드는 닫는다(옛 배치가 새 지시로 실행되지 않게)
    limitTimers.forEach(clearTimeout);
    limitTimers = [];
    for (const m of chat) if (m.confirm?.state === "open") m.confirm.state = "dropped";
    save();
    ctx.instruction = raw;
    ctx.planConfirmed = false;
    ctx.rounds = 0;
    ctx.mergeTitle = ctx.mergeBody = undefined;
    mergeNotes = [];
    askLead({ kind: "user", text: raw });
  }

  function onConfirm(cid: string, ok: boolean) {
    const c = chat.find((m) => m.confirm?.id === cid)?.confirm;
    if (!c || c.state !== "open") return;
    if (c.instruction) ctx.instruction = c.instruction;
    if (c.kind === "merge") {
      c.state = ok ? "ok" : "dropped";
      save();
      if (ok) void doMerge(!!c.stash);
      else note("브랜치에 남겨 둘게요 — 다음에 합칠 때 함께 합쳐요");
      return;
    }
    if (c.kind === "branch") {
      c.state = ok ? "ok" : "dropped";
      save();
      if (!ok) return note("합치지 않고 브랜치에 남겨 둘게요 — 다음에 합칠 때 함께 합쳐요");
      void (async () => {
        const err = await invoke("team_new_branch", { repo: dir, name: c.branch }).then(() => "", (e) => String(e));
        if (err) return note(`⚠ 브랜치를 만들지 못했어요: ${err}`);
        note(`${c.branch} 브랜치를 만들어 옮겼어요 — 여기에 합쳐요`);
        await doMerge();
      })();
      return;
    }
    if (c.kind === "pr") {
      c.state = ok ? "ok" : "dropped";
      save();
      if (ok && c.pr) void pushPr(c.pr);
      else note("올리지 않았어요 — 합친 내용은 내 PC 브랜치에 있어요");
      return;
    }
    if (c.kind === "git") {
      c.state = ok ? "ok" : "dropped";
      save();
      void (async () => {
        if (ok) {
          const err = await invoke("team_init", { repo: dir }).then(() => "", (e) => String(e));
          if (err) {
            note(`⚠ git 저장소를 만들지 못해 같은 폴더에서 일해요 (${err})`);
            if (lead) lead.branchOff = true;
          } else note("git 저장소를 만들었어요 — 에이전트마다 자기 브랜치에서 일해요");
        } else if (lead) {
          lead.branchOff = true;
          note("같은 폴더에서 일해요(브랜치 없이)");
        }
        persist();
        if (c.actions?.length) await execute(c.actions);
      })();
      return;
    }
    if (!ok) {
      c.state = "revise";
      revisePending = true;
      save();
      return note("고칠 내용을 적어 보내 주세요 — 팀장이 반영하고, 다음 배치부터 기억해요");
    }
    c.state = "ok";
    save();
    if (c.kind === "plan") ctx.planConfirmed = true;
    const acts = c.actions ?? [];
    const next = () => askLead({ kind: "confirmed", text: `"${c.title}"을(를) 사용자가 확인했다. 다음 단계를 배치하라.` });
    // 맡길 일까지 있으면 실행, 만들기·역할 바꾸기만 있었거나 없으면 팀장에게 다음 배치를 받는다
    // 확인받은 배치에 합치기도 있으면 먼저 합치고 맡긴다(onLead와 같은 까닭)
    const run = acts.some((a) => a.type === "merge") ? mergeThenExecute : execute;
    if (acts.some((a) => a.type === "assign")) void run(acts).then((r) => r === "none" && next());
    else if (acts.length) void run(acts).then((r) => r !== "held" && next());
    else next();
  }

  // ---------- 에이전트 안내(그 대화에 처음·구성 변경·압축·새 대화 때만 전체) ----------
  const roleSent: Record<string, string> = {};
  function promptFor(mid: string, instruction: string, task: string | undefined, memo: string | undefined, together: boolean): string {
    const key = teamKey(members);
    const prev = roleSent[mid];
    const full = prev !== key;
    roleSent[mid] = key;
    // 팀장이 사용자에게 정리하므로 일하는 에이전트는 보고 없이 인계만(quiet)
    const p = teamPrompt({ me: memberOf(mid), members, instruction, task, memo, together, full, changed: full && !!prev, quiet: true });
    const m = memberOf(mid);
    // 자기 브랜치 작업 폴더에서 일한다 — 원래 폴더는 읽기만(합치기는 팀장이)
    return m?.wt ? `[작업 폴더] 너는 자기 브랜치 작업 폴더(${m.wt})에서 일한다. 원래 폴더(${dir})의 파일은 고치지 말고 필요하면 읽기만 하라. 커밋·합치기는 팀장이 한다(단, 충돌을 풀라는 일을 받으면 자기 작업 폴더에서 원래 브랜치를 git merge로 합치고 충돌 표시를 모두 풀어 커밋한다).${projectKind !== "other" ? " 에디터는 열지 말고 코드만 고쳐라." : ""}\n\n${p}` : p;
  }

  // ---------- 팀 지시(팀장이 맡긴 일) ----------
  let input = $state("");
  let picker = $state<string | null>(null);
  let openCard = $state("");
  let cmdIds: string[] = [];
  /** @이름으로 직접 시킨 일의 글 */
  const soloText: Record<string, string> = {};
  let tasks: Record<string, string> = {};
  /** 동시 실행 상한을 넘어 기다리는 에이전트 */
  let waiting = $state<string[]>([]);
  let curText = "";
  /** 에이전트별로 받은 인계 메모(받을 에이전트 기준) */
  const memoFor: Record<string, string> = {};
  /** 에이전트별 마지막 답(카드의 마지막 인계) */
  const lastAns = $state<Record<string, string>>({});
  const laneStart: Record<string, number> = {};
  let stopped = false;
  let cmdStart = 0;
  let lastAnswer = "";
  let answers: string[] = [];
  /** 이번 지시의 에이전트별 결과(인계 포함) — 팀장에게 넘긴다 */
  let results: { name: string; answer: string }[] = [];
  const notice = (kind: "done" | "error" | "limit", body?: string) =>
    notify({ kind, title: titleFor(id, "팀"), body, tabId: id, startedAt: kind === "done" ? cmdStart : undefined });

  function watchOn() { invoke("watch_start", { id, cwd: dir }).catch(() => {}); }
  function watchOff() { setTimeout(() => !busy && invoke("watch_stop", { id }).catch(() => {}), 1000); }
  const busyCount = () => members.filter((m) => isWorker(m) && working(m.id)).length;

  /** 순서(order)에서 아직 시작하지 않은 단계(앞 단계가 모두 끝나면 다음 단계) */
  let stages = $state<string[][]>([]);

  /** 이 에이전트들에게 이 지시를(몫이 있으면 그 몫으로) 시작. order가 있으면 단계대로(앞 단계 결과를 인계로 받아 다음 단계) */
  function begin(ids: string[], text: string, preset: Record<string, string>, order?: string[][]) {
    curText = text;
    tasks = preset;
    stopped = false;
    cmdStart = Date.now();
    lastAnswer = "";
    answers = [];
    results = [];
    cmdIds = ids;
    watchOn();
    const plan = order && order.length > 1 ? order.map((st) => st.filter((x) => ids.includes(x))).filter((st) => st.length) : [ids];
    stages = plan.slice(1);
    startRound(plan[0]);
  }

  /** 함께 시작(동시 실행 상한까지, 나머지는 앞 에이전트가 끝나면) */
  function startRound(list: string[]) {
    if (!list.length) return finishCommand();
    const { now, later } = splitByCap(list, busyCount(), hqMax());
    waiting = later;
    for (const mid of now) launch(mid, list.length > 1);
  }

  /** extra: 일하는 중에 팀장이 더 맡긴 일로 합류할 때 그 글과 몫 */
  function launch(mid: string, together: boolean, extra?: { text: string; task?: string }) {
    const lane = laneOf(mid);
    if (!lane) return;
    inCmd[mid] = true;
    // 디스크가 바닥나면 팀원 일은 기다렸다 보낸다(지금 일하는 에이전트는 그대로)
    if (isStopped(dir)) {
      if (!diskHeld.some((h) => h.mid === mid)) diskHeld.push({ mid, together, extra });
      return note(`디스크가 부족해 ${memberOf(mid)?.name ?? mid}에게 보내지 않고 기다려요 — 공간이 생기면 이어서 보내요`);
    }
    const memo = memoFor[mid] || undefined;
    memoFor[mid] = ""; // 한 번 전달하면 비운다
    const instruction = extra ? extra.text : curText;
    const prompt = promptFor(mid, instruction, extra ? extra.task : tasks[mid], memo, together);
    laneStart[mid] = Date.now();
    lane.work.user(extra?.task ?? tasks[mid] ?? instruction);
    void prepWt(mid)
      .then((pre) => lane.send(pre ? `${pre}\n\n${prompt}` : prompt, extra?.text ?? curText))
      .catch(() => {
        roleSent[mid] = ""; // 못 보냈으면 다음에 안내부터
        finishTurn(mid, "");
      });
  }

  /** 저장공간 정리에 알려 줄 것: 이 팀의 폴더, 건드리면 안 되는 작업 폴더·레인(일하는 중·프로세스가 떠 있음), 이어 쓰는 대화 */
  const laneBusy = (L: Lane | undefined, mid: string) => working(mid) || !!L?.state.running || (L?.state.bg ?? 0) > 0 || !!L?.state.live;
  onMount(() => registerStorage(id, {
    repos: () => (dir ? [dir] : []),
    skipWts: () => members.filter((m) => m.wt && laneBusy(laneOf(m.id), m.id)).map((m) => m.wt!),
    skipLanes: () => members.filter((m) => laneBusy(laneOf(m.id), m.id)).map((m) => laneOf(m.id)?.pid ?? ""),
    keepIds: () => members.map((m) => m.resume ?? ""),
    note: (t) => note(t),
  }));

  /** 디스크가 부족해 기다리는 팀원 일 — 풀리면 이어서 보낸다 */
  let diskHeld: { mid: string; together: boolean; extra?: { text: string; task?: string } }[] = [];
  $effect(() => {
    if (isStopped(dir)) return;
    untrack(() => {
      const held = diskHeld;
      diskHeld = [];
      for (const h of held) if (inCmd[h.mid] && !stopped) launch(h.mid, h.together, h.extra);
    });
  });

  /**
   * 일을 보내기 직전에 팀원 작업 폴더를 준비한다: 오래 쉬어 지운 폴더는 같은 경로에 다시 만들고, 원래 브랜치에 맞춘다.
   * 맞추지 못하면(충돌 등) 그 팀원이 먼저 풀게 지시 앞에 붙일 글을 돌려준다
   */
  async function prepWt(mid: string): Promise<string> {
    const m = memberOf(mid);
    if (!m?.wt || m.lead || !lead?.chat) return "";
    const team = lead.chat;
    await invoke<string>("team_wt", { repo: dir, team, member: mid }).catch(() => "");
    const err = await invoke("team_sync", { repo: dir, team, member: mid }).then(() => "", (e) => String(e));
    if (!err) return "";
    const base = (await invoke<{ branch: string }>("team_repo", { repo: dir }).catch(() => null))?.branch || "원래 브랜치";
    note(`⚠ ${m.name}: 원래 브랜치에 맞추지 못해 먼저 풀게 했어요 (${err.replace(/^.*CONFLICT:\s*/, "충돌: ")})`);
    return syncNote(base, err);
  }

  /** 팀장이 맡긴 일: 아무 일도 없으면 새로 시작, 일하는 중이면 일하는 에이전트에 끼워 넣고 쉬는 에이전트는 합류 */
  function dispatch(ids: string[], text: string, preset: Record<string, string>, order?: string[][]) {
    if (!cmdOn && !Object.values(solo).some(Boolean)) return begin(ids, text, preset, order);
    const assign = ids.map((x) => ({ id: x, task: preset[x] ?? text }));
    // "앞 에이전트가 끝난 뒤"로 정한 몫(later)은 지금 보내지 않는다 — 일하는 에이전트에 끼워 넣으면 기다리지 않고 바로 해 버린다
    const r = routeExtra(assign, working, order && order.length > 1 ? order[0] : undefined);
    const start = r.start;
    // 일하는 에이전트에 끼워 넣지 않고 지금 일이 끝난 뒤 이어서 — 끼워 넣은 몫의 결과는 팀장에게 가지 않으므로
    const later = [...r.interject, ...r.later];
    if (!cmdOn) {
      // @이름 일만 돌던 중: 쉬는 에이전트들로 시작하고, 시작할 에이전트가 없으면 그 일이 끝난 뒤 뒤 단계를
      const all = [...start, ...later];
      const pre = Object.fromEntries(all.map((x) => [x.id, x.task]));
      if (start.length) return begin(all.map((x) => x.id), text, pre, [start.map((x) => x.id), ...(later.length ? [later.map((x) => x.id)] : [])]);
      if (later.length) afterSolo = { ids: later.map((x) => x.id), text, preset: pre };
      return;
    }
    for (const x of start) {
      if (!cmdIds.includes(x.id)) cmdIds = [...cmdIds, x.id];
      launch(x.id, true, { text, task: x.task });
    }
    if (later.length) {
      for (const x of later) {
        if (!cmdIds.includes(x.id)) cmdIds = [...cmdIds, x.id];
        tasks[x.id] = x.task;
      }
      stages = [...stages, later.map((x) => x.id)];
    }
  }

  /** 답의 인계 메모를 받을 에이전트들에 쌓는다(다음 배치는 팀장이 정한다 — 요청으로 자동으로 깨우지 않음) */
  function collectMemos(mid: string, answer: string) {
    const m = memberOf(mid);
    if (!m || isNoShare(answer)) return;
    for (const [to, memo] of Object.entries(memosFrom(answer, m, members))) memoFor[to] = memoFor[to] ? `${memoFor[to]}\n${memo}` : memo;
  }

  function finishCommand() {
    watchOff();
    if (cmdStart) {
      const files = lanes.map((l, i) => {
        const f = changedSince(l.work.files, cmdStart);
        return i === 0 ? f : f.replace("\n\n[바뀐 파일]", "");
      }).join("");
      if (stopped) finishRemote(`[팀 결과]\n${answers.join("\n\n") || "(답변 없음)"}${files}`);
      // 결과는 팀장에게(폰에는 팀장의 보고가 간다) — 팀장이 사용자에게 보고하거나 다음 배치를 낸다
      // 이 일과 함께 낸 합치기의 결과도 함께(팀장이 합쳐졌는지 알고 다음을 정하게)
      const merged = mergeNotes.map((answer) => ({ name: "앱(합치기)", answer }));
      if (!stopped) askLead({ kind: "results", text: curText, results: [...merged, ...results], files: files.replace(/^\s*\[바뀐 파일\]\s*/, ""), overlaps: overlapsSince(cmdStart) });
      mergeNotes = [];
    }
    cmdStart = 0;
  }

  /** 이 시각 이후 에이전트별로 고친 파일(저장소 기준) → 겹친 일 의심 줄 */
  function overlapsSince(since: number): string[] {
    return overlapsFrom(
      workers.map((m) => ({
        name: m.name,
        files: (laneOf(m.id)?.work.files ?? []).filter((f) => f.kind === "edit" && f.path && f.touchedAt >= since).map((f) => relTo(dirOf(m), f.path!)),
      })),
    );
  }
  /** 그 에이전트 폴더 기준 상대 경로(저장소 기준) */
  function relTo(root: string, p: string): string {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    const q = p.replace(/\\/g, "/");
    return q.toLowerCase().startsWith(r.toLowerCase()) ? q.slice(r.length) : q;
  }

  /** 지시 없이 스스로 이어 답한 차례: 인계만 쌓는다 */
  function lateAnswer(mid: string, full: string) {
    if (!/인계/.test(full)) return; // 인계를 쓰지 않은 이어 답은 넘기지 않는다(끝 몇 줄이 잡음으로 가지 않게)
    lastAns[mid] = full;
    collectMemos(mid, full);
    // 백그라운드 작업(빌드·테스트)이 끝나 스스로 이어 쓴 인계도 팀장에게 — 안 넘기면 팀장은 그 결과를 계속 기다리고
    // 에이전트는 다 끝내고 쉬는 채로 멈춘다. 지시가 돌고 있으면 그 결과에 함께, 아니면 바로 전한다
    const m = memberOf(mid);
    if (!m || isNoShare(full)) return;
    const answer = `(백그라운드 작업이 끝난 뒤 이어서 낸 결과)\n${full}`;
    if (cmdOn || waiting.length || stages.length) results.push({ name: m.name, answer });
    else askLead({ kind: "results", text: ctx.instruction, results: [{ name: m.name, answer }] });
  }

  function finishTurn(mid: string, answer: string, full?: string) {
    checkTrespass(mid);
    const m = memberOf(mid);
    if (!m) return;
    if (full ?? answer) lastAns[mid] = full ?? answer;
    if (solo[mid]) {
      solo[mid] = false;
      watchOff();
      if (afterSolo && !Object.values(solo).some(Boolean) && !cmdOn) {
        const a = afterSolo;
        afterSolo = null;
        queueMicrotask(() => begin(a.ids.filter((x) => laneOf(x)?.state.ready), a.text, a.preset));
      }
      collectMemos(mid, full ?? answer);
      // @이름으로 직접 시킨 일의 결과도 팀장이 사용자에게 전한다
      if (!isNoShare(answer)) askLead({ kind: "direct", text: soloText[mid] ?? "", results: [{ name: m.name, answer: full ?? answer }], files: changedSince(laneOf(mid)?.work.files ?? [], soloStart[mid] ?? 0).replace(/^\s*\[바뀐 파일\]\s*/, "") });
      return;
    }
    if (!inCmd[mid]) return;
    inCmd[mid] = false;
    if (nightOn() && lead?.night) {
      const log = laneOf(mid)?.work.log ?? [];
      const ok = !!answer.trim() && !(log.length && log[log.length - 1].kind === "error");
      const n = noteResult(lead.night.fails, mid, ok);
      lead.night.fails = n.fails;
      if (n.stop) endNightMode(`${m.name}이(가) 연달아 ${n.fails[mid]}번 실패해서 멈췄어요`, true);
    }
    if (answer) {
      lastAnswer = answer;
      answers.push(`${m.name}: ${answer}`);
      if (!isNoShare(answer)) results.push({ name: m.name, answer: full ?? answer });
    }
    // 동시 실행 상한 때문에 기다리던 에이전트가 있으면 이어서
    const next = waiting.shift();
    if (next && !stopped) launch(next, true);
    collectMemos(mid, full ?? answer);
    if (!cmdOn && !waiting.length) {
      const st = stopped ? undefined : stages.shift();
      if (st) return startRound(st.filter((x) => laneOf(x)?.state.ready && !solo[x]));
      finishCommand();
    }
  }

  /** 영역 침범: 그 에이전트가 직접 고친 파일(도구가 확정한 기록)로, 차례가 끝날 때 본다 */
  function checkTrespass(mid: string) {
    const lane = laneOf(mid);
    const m = memberOf(mid);
    if (!lane || !m || m.lead) return;
    const edited = lane.work.files.filter((f) => f.kind === "edit" && f.path && (f.settledAt ?? 0) >= (laneStart[mid] ?? 0)).map((f) => relTo(dirOf(m), f.path!));
    laneStart[mid] = Date.now(); // 같은 파일로 두 번 알리지 않게
    const bad = trespassTeam(edited, m, members);
    if (!bad.length) return;
    const owners = members.filter((o) => o.id !== mid && bad.some((p) => matchOwns(p, o.areas))).map((o) => o.name);
    note(`⚠ ${m.name}가 ${owners.join("·")} 영역(${bad.slice(0, 3).join(", ")}${bad.length > 3 ? " 외" : ""})을 수정했어요`);
  }

  /** 감시자가 잡은 변경: 일하는 에이전트의 기록에 반영(여럿이면 담당 경로로 나눠서) */
  function onFsChange(changes: FsChange[]) {
    // 원래 폴더 감시 — 자기 브랜치 작업 폴더에서 일하는 에이전트의 것이 아니다
    const run = workers.filter((m) => working(m.id) && !m.wt);
    if (!run.length) return;
    const root = dir.replace(/\\/g, "/").replace(/\/+$/, "").length + 1;
    const relOf = (c: FsChange) => c.path.replace(/\\/g, "/").slice(root);
    for (const m of run) {
      const lane = laneOf(m.id);
      if (!lane) continue;
      const mine = run.length === 1 ? changes : changes.filter((c) => {
        const owner = run.find((y) => matchOwns(relOf(c), y.areas));
        return !owner || owner.id === m.id;
      });
      if (mine.length) void applyFsChanges(lane.work, dir, mine, io, lane.tag());
    }
  }

  // ---------- @이름 직접 지시·중단 ----------
  function directSend(mid: string, text: string) {
    const lane = laneOf(mid);
    if (!text || !lane?.state.ready) return note(`${memberOf(mid)?.name ?? mid}이(가) 아직 준비 중이에요`);
    if (working(mid)) return lane.interject(text);
    solo[mid] = true;
    soloText[mid] = text;
    soloStart[mid] = Date.now();
    lane.work.user(text);
    watchOn();
    laneStart[mid] = Date.now();
    void prepWt(mid).then((pre) => {
      const p = promptFor(mid, text, undefined, undefined, false);
      return lane.send(pre ? `${pre}\n\n${p}` : p, text);
    }).catch(() => {
      roleSent[mid] = "";
      finishTurn(mid, "");
    });
  }

  /** @이름 일이 도는 중에 팀장이 맡긴 뒤 단계 — 그 일이 끝나면 시작 */
  let afterSolo: { ids: string[]; text: string; preset: Record<string, string> } | null = null;
  async function stop() {
    if (lead?.night) endNightMode("멈췄어요", false);
    epoch += 1;
    limitTimers.forEach(clearTimeout);
    limitTimers = [];
    stopped = true;
    afterSolo = null;
    revisePending = false;
    waiting = [];
    stages = [];
    leadQueue = [];
    for (const m of members) {
      if (!working(m.id) && !(m.lead && leadWorking)) continue;
      inCmd[m.id] = false;
      solo[m.id] = false;
      await laneOf(m.id)?.stop();
    }
    leadWorking = false;
    leadTurn = null;
    cmdStart = 0;
    watchOff();
    note("— 멈췄어요 —");
    finishRemote("[팀] PC에서 작업을 중단했어요.");
  }
  let rootEl: HTMLDivElement;
  function onEsc(e: KeyboardEvent) {
    if (e.key !== "Escape" || !busy || !rootEl?.contains(e.target as Node)) return;
    e.preventDefault();
    void stop();
  }

  // ---------- 목적대로 바로 시작 → 팀장에게 ----------
  async function runKickoff(k: Kickoff) {
    const until = Date.now() + 180_000;
    while (Date.now() < until && !leadLane()?.state.ready) await new Promise((r) => setTimeout(r, 500));
    const keep = input;
    input = k.goal;
    await send();
    input = keep;
  }

  // ---------- 폰(원격 @pair) ----------
  let remoteDone: ((text: string) => void) | null = null;
  function finishRemote(text: string) {
    const r = remoteDone;
    remoteDone = null;
    r?.(text);
  }
  function remoteSend(text: string): Promise<string> {
    if (busy || !leadLane()?.state.ready) return Promise.reject(new Error("팀 탭이 준비 중이거나 작업 중이에요"));
    return new Promise((res) => {
      remoteDone = res;
      note("— 폰에서 보낸 지시 —");
      input = text;
      void send();
    });
  }
  const unregister = registerTab(untrack(() => id), { kind: "pair", cwd: dir, running: () => busy, last: () => lastLeadSay || lastAnswer, send: remoteSend });

  // ---------- 역할·담당(이름·맡을 일·담당 경로) ----------
  let areaEdit = $state<Record<string, RoleEdit> | null>(null);
  function openAreas() {
    areaEdit = Object.fromEntries(workers.map((m) => [m.id, { name: m.name, purpose: m.purpose, areas: m.areas.join("\n") }]));
  }
  function saveAreas() {
    if (!areaEdit) return;
    // 바뀌면 teamKey가 달라져 다음 지시에 전체 안내가 다시 붙는다
    const notes = applyRoleEdits(members, areaEdit);
    if (notes.length) note(`역할 변경: ${notes.join(" · ")}`);
    persist();
    areaEdit = null;
  }

  /** 몇 단계 안쪽 폴더 목록 — 영역 자동 감지·목적 제안에 쓴다 */
  const scanDirs = () => scanTree(dir, readDir);

  // ---------- 시작 ----------
  let unlisten: UnlistenFn[] = [];
  const idleTimer = setInterval(() => {
    lanes.forEach((l) => l.tick());
    nowTick = Date.now();
    if (lead?.night && !nightActive(lead.night, nowTick)) endNightMode("정한 시간이 다 됐어요", true);
  }, 30_000);

  // ---- 하던 일 남기기: 앱이 업데이트·꺼짐으로 다시 켜져도 팀장이 이어서 하게(몇 초마다, 바뀐 것만) ----
  let flightTimer: ReturnType<typeof setInterval> | undefined;
  let flightLast = "";
  function flightNow(): Flight | null {
    const running = workers
      .filter((m) => inCmd[m.id] || solo[m.id] || working(m.id) || (laneOf(m.id)?.state.bg ?? 0) > 0)
      .map((m) => ({ id: m.id }));
    const res = cmdStart && !stopped
      ? results.map((r) => ({ id: members.find((m) => m.name === r.name)?.id, name: r.name, answer: r.answer }))
      : [];
    const f: Flight = {
      at: Date.now(),
      text: curText || ctx.instruction,
      results: res,
      running,
      pending: stopped ? [] : [...new Set([...waiting, ...stages.flat(), ...execPending.filter((x) => !working(x))])],
      lead: leadWorking ? lastLeadAsk : null,
      queue: [...leadQueue],
    };
    return flightEmpty(f) ? null : f;
  }
  function saveFlight() {
    const f = flightNow();
    const s = f ? JSON.stringify({ ...f, at: 0 }) : "";
    if (s === flightLast) return;
    flightLast = s;
    invoke("team_flight_save", { dir, value: f }).catch(() => {});
  }

  onMount(async () => {
    unlisten.push(await listen<{ id: string; changes: FsChange[] }>("work-fs-change", (e) => {
      if (e.payload.id === id) onFsChange(e.payload.changes);
    }));
    if (!dir) return;
    // 지난번에 하다 만 일(앱이 꺼지기 전에 남긴 것) — 가져가면 지워진다. 남기기는 가져간 뒤에 시작
    const flight = await invoke<Flight | null>("team_flight_take", { dir }).catch(() => null);
    flightTimer = setInterval(saveFlight, 3000);
    const saved = untrack(() => team);
    let base: Member[];
    if (saved?.length) base = plainTeam(saved);
    else {
      // 옛 협업 탭: 역할(로컬 저장)·직접 정한 영역(설정) 또는 자동 감지로 두 에이전트
      let roles: Roles = { ...DEFAULT_ROLES };
      try { roles = { ...DEFAULT_ROLES, ...JSON.parse(localStorage.getItem(`aith.pair.roles:${fileKey(dir)}`) ?? "{}") }; } catch {}
      const key = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const areas: Areas = settings.pairAreas?.[key] ?? detectAreas(await scanDirs());
      base = fromPair({ resume: untrack(() => resume), resume2: untrack(() => resume2), models: untrack(() => models) }, roles, areas);
    }
    // 팀장이 없는 팀(옛 팀)이면 팀장을 맨 앞에 — 다른 에이전트의 대화·모델·역할은 그대로, 브리핑 담당은 팀장이 맡는다
    const mig = migrateTeam(base);
    members = mig.members;
    const ld = members.find((m) => m.lead);
    const fresh = !!ld && !ld.chat;
    if (ld && !ld.chat) ld.chat = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (mig.changed || fresh || !saved?.length) persist();
    chat = loadChat(store(), dir, chatId());
    const open = openConfirm(chat);
    if (open?.instruction) ctx.instruction = open.instruction;
    if (mig.changed) note("팀장이 합류했어요 — 이제 팀장에게 지시하면 나눠 맡기고 결과를 보고해요");
    projectKind = await invoke<string>("team_kind", { repo: dir }).catch(() => "other");
    // 저장된 작업 폴더가 없어졌으면(지웠거나 다른 PC) 원래 폴더에서.
    // 단, 저장공간 정리가 지운 것(브랜치는 남아 있음)은 그대로 둔다 — 다음 일을 받을 때 같은 경로에 다시 만들고(prepWt) 그 대화를 이어 쓴다
    for (const m of members) {
      if (!m.wt) continue;
      const ok = await invoke<{ is_git: boolean }>("team_repo", { repo: m.wt }).then((r) => r.is_git, () => false);
      const swept = !ok && !!ld?.chat && (await invoke<boolean>("team_branch_exists", { repo: dir, team: ld.chat, member: m.id }).catch(() => false));
      if (!ok && !swept) {
        m.wt = undefined;
        persist();
      }
    }
    await recoverModels();
    lanes = members.map((m) => makeLane(m));
    // 이을 대화가 정해진 에이전트만 그 대화로. 아직 대화가 없는 에이전트(새 팀·새 팀장)는 새 대화로 시작한다 —
    // 안 그러면 모두 이 폴더의 최근 대화(다른 탭·다른 에이전트의 것)를 한꺼번에 이어받아 서로 부딪치고 첫 지시부터 오류가 난다
    await Promise.all(lanes.map(async (l) => { await l.init(); await l.start(l.member.resume ? undefined : null); }));
    const again = resumeTurns(flight, members, Date.now());
    if (again.length) {
      if (!ctx.instruction && flight?.text) ctx.instruction = flight.text;
      note("앱이 다시 켜져서, 하던 일을 팀장에게 이어서 맡겨요");
      for (const t of again) askLead(t);
    }
    const k = untrack(() => kickoff);
    if (k) {
      onkickoff?.(); // 먼저 지워서 앱을 다시 켜도 또 시작하지 않게
      void runKickoff(k);
    }
  });

  // 다른 곳에서 넣어 준 글 → 입력창
  $effect(() => {
    const t = fills[id];
    if (t) untrack(() => {
      input = joinInput(input, t);
      delete fills[id];
    });
  });

  onDestroy(() => {
    clearInterval(flightTimer);
    if (flightTimer) invoke("team_flight_save", { dir, value: null }).catch(() => {});
    limitTimers.forEach(clearTimeout);
    setWorking(id, false);
    setBackground(id, false);
    setBusy(id, false);
    clearInterval(idleTimer);
    unregister();
    finishRemote("[팀] 허브에서 탭이 닫혔어요.");
    unlisten.forEach((u) => u());
    lanes.forEach((l) => l.dispose());
    invoke("watch_stop", { id }).catch(() => {});
  });

  /** 카드에 보일 마지막 오류 글(멈춰 있을 때만) */
  const lastError = (mid: string) => {
    const log = laneOf(mid)?.work.log ?? [];
    const e = log[log.length - 1];
    return e?.kind === "error" && !working(mid) ? e.text : "";
  };
  /** 카드에 보일 바뀐 파일(최근 것부터) */
  const editedFiles = (mid: string) =>
    (laneOf(mid)?.work.files ?? [])
      .filter((f) => f.kind === "edit")
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .map((f) => f.path ?? f.label);
  let nWorking = $derived(workers.filter((m) => working(m.id)).length);
</script>

<svelte:window onkeydown={onEsc} />

<div class="team" bind:this={rootEl}>
  <div class="bar">
    <span class="sum">팀 · 에이전트 {workers.length}명{#if nWorking} · 작업 중 {nWorking}{/if}</span>
    <button class="add" onclick={() => (showAdd = true)}>＋ 에이전트</button>
    {#if lead}
      <span class="seg" role="group" aria-label="운영 방식">
        <button class:on={mode === "lite"} disabled={mode === "max"} onclick={() => setMode("lite")} title={mode === "max" ? "맥스 팀은 라이트로 바꿀 수 없어요 — 라이트는 새 팀으로 만들어 주세요" : "토큰 아끼기 — 팀장 Sonnet, 최대 4명, 최상위 모델·브라우저 안 씀"}>라이트</button>
        <button class:on={mode === "max"} onclick={() => setMode("max")} title="품질·속도 — 팀장 Opus, 인원 제한 없음, 합치기 전 검증">맥스</button>
      </span>
    {/if}
    <span class="sp"></span>
    {#if lead}
      {#if night}
        <button class="night on" onclick={() => endNightMode("직접 껐어요", false)} title="누르면 밤새 모드를 꺼요">🌙 밤새 모드 · {Math.max(0, Math.ceil(((lead.night?.until ?? 0) - nowTick) / 3600_000))}시간 남음</button>
      {:else}
        <button class="night" onclick={() => startNightMode()} title="{NIGHT_HOURS}시간 동안 확인 카드(배치·역할·후속)를 자동 승인하고 합치기도 바로 해요. 기획 확인·합치기 대기·충돌은 아침까지 남기고, 같은 에이전트가 3번 연달아 실패하면 멈춰요">🌙 밤새 모드</button>
      {/if}
      <label class="ck" title="에이전트들이 각자 브랜치에서 한 일을 지금 브랜치에 합치기 전에 물어봐요"><input type="checkbox" checked={lead.mergeAsk !== false} onchange={(e) => { lead!.mergeAsk = (e.currentTarget as HTMLInputElement).checked; persist(); }} /> 합치기 전에 물어보기</label>
    {/if}
    <span class="perm" class:full={settings.fullAccess} title={settings.fullAccess ? "Claude 모든 도구 · Codex 샌드박스 없음" : "Claude 편집만 · Codex 프로젝트 폴더 안만"}>{settings.fullAccess ? "전체 권한" : "제한 권한"}</span>
    <button class="meta" onclick={openAreas} disabled={!workers.length} title={workers.map((m) => `${m.name}: ${m.areas.join(", ") || "미지정"}`).join("\n")}><Icon name="info" size={13} />역할·담당</button>
    {#if areaEdit}
      <div class="pop-back" role="presentation" onclick={() => (areaEdit = null)}></div>
      <div class="pop" role="dialog" aria-label="역할·담당">
        <div class="ah"><b>역할·담당</b><span class="dim">이름·맡을 일·담당 경로 · 경로는 한 줄에 하나(예: web/login/** · **/*.kt)</span></div>
        {#each workers as m (m.id)}
          <div class="re">
            <div class="rr">
              <i class="dot {m.cli}"></i>
              <input class="rn" placeholder="이름" aria-label="{m.name} 이름" bind:value={areaEdit[m.id].name} />
              <input class="rp" placeholder="맡을 일" aria-label="{m.name} 맡을 일" bind:value={areaEdit[m.id].purpose} />
            </div>
            <textarea rows="2" placeholder="담당 경로" aria-label="{m.name} 담당 경로" bind:value={areaEdit[m.id].areas}></textarea>
          </div>
        {/each}
        <div class="ab">
          <span class="sp"></span>
          <button onclick={() => (areaEdit = null)}>취소</button>
          <button class="ok" onclick={saveAreas}>저장</button>
        </div>
      </div>
    {/if}
  </div>

  {#if showAdd}
    <AddAgent cwd={dir} {members} {scanDirs} onadd={async (d, goal) => {
      showAdd = false;
      const ids = await addMembers(d);
      const k = goal ? kickoffFrom(goal, d, ids.map((x) => ({ id: x }))) : null;
      if (k) void runKickoff(k);
    }} onclose={() => (showAdd = false)} />
  {/if}

  <div class="main">
    <LeadChat
      msgs={chat}
      thinking={leadWorking}
      bind:value={input}
      cwd={dir}
      disabled={!leadLane()}
      running={busy}
      placeholder={revisePending ? "고칠 내용을 적어 주세요" : busy ? "작업 중 — 보내면 팀장에게 끼워 넣어요 · @이름으로 그 에이전트에게 직접" : "팀장에게 지시하기… · @이름으로 그 에이전트에게 직접"}
      onsend={send}
      oncancel={stop}
      oninterject={send}
      onconfirm={onConfirm}
    />
    <aside class="side">
      <div class="lbl">에이전트 {workers.length}</div>
      {#if !workers.length}
        <div class="none">아직 없어요. 팀장이 필요할 때 만들어요.</div>
      {/if}
      {#each workers as m (m.id)}
        {@const L = laneOf(m.id)}
        {#if L}
          <AgentCard
            name={m.name}
            cli={m.cli}
            model={m.model}
            effort={m.effort}
            purpose={m.purpose}
            state={stateOf(m.id)}
            activity={activityLine(L.work.log, working(m.id) || L.state.running)}
            handoff={lastHandoff(lastAns[m.id] ?? "")}
            error={lastError(m.id)}
            quiet={L.state.quietMin}
            files={editedFiles(m.id)}
            open={openCard === m.id}
            detail={mode === "max"}
            ontoggle={() => (openCard = openCard === m.id ? "" : m.id)}
            onmodel={(v) => { L.setModel(v); m.maxModel = undefined; persist(); }}
            oneffort={(v) => { L.setEffort(v); persist(); }}
            onpick={() => (picker = m.id)}
            onremove={() => removeMember(m.id)}
          />
          {#if picker === m.id}
            <SessionPicker cli={m.cli} cwd={dir} current={L.sessionId()} onpick={(sel) => { picker = null; roleSent[m.id] = ""; void L.pickSession(sel); }} onclose={() => (picker = null)} />
          {/if}
        {/if}
      {/each}
      {#if lead}
        <div class="foot">
          팀장 · {lead.model === "auto" ? "자동" : lead.model}{lead.effort ? ` · 생각 ${lead.effort}` : ""} · {prof.label} — 코드는 고치지 않아요
          {#if leadLane() && !leadLane()!.state.ready}
            <span class="lerr">팀장이 멈춰 있어요 <button onclick={restartLead}>다시 시작</button> <button onclick={() => lead && (picker = lead.id)}>대화 고르기</button></span>
          {/if}
        </div>
        {#if picker === lead.id && leadLane()}
          <SessionPicker cli="claude" cwd={dir} current={leadLane()!.sessionId()} onpick={(sel) => { picker = null; leadSent = ""; void leadLane()!.pickSession(sel); }} onclose={() => (picker = null)} />
        {/if}
      {/if}
    </aside>
  </div>
</div>

<style>
  .team { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--bg); }
  .bar { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px; border-bottom: 1px solid var(--border-soft); background: var(--bg-elev); font-size: 12px; }
  .add { flex: none; padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font-size: 11.5px; cursor: pointer; }
  .add:hover { border-color: var(--accent); }
  .ck { display: flex; align-items: center; gap: 6px; color: var(--fg); cursor: pointer; }
  .ck input { margin: 0; }
  .sum { color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .sp { flex: 1; }
  .night { padding: 2px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted); font-size: 11.5px; cursor: pointer; }
  .night.on { border-color: color-mix(in srgb, var(--accent-2) 60%, var(--border)); color: var(--accent-2); }
  .seg { display: inline-flex; padding: 2px; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .seg button { padding: 2px 10px; border: none; border-radius: calc(var(--radius-sm) - 2px); background: transparent; color: var(--muted); font-size: 11.5px; cursor: pointer; }
  .seg button.on { background: var(--surface-2); color: var(--fg); font-weight: 600; }
  .perm { padding: 0 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--muted); font-size: 11px; line-height: 18px; cursor: help; }
  .perm.full { border-color: color-mix(in srgb, var(--warn) 60%, var(--border)); color: var(--warn); }
  .meta { display: inline-flex; align-items: center; gap: 5px; border: none; background: none; padding: 0; color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer; }
  .meta:hover:not(:disabled) { color: var(--fg); }
  .meta:disabled { opacity: 0.4; cursor: default; }
  .pop-back { position: fixed; inset: 0; z-index: 40; }
  .pop { position: absolute; top: 38px; right: 12px; z-index: 41; width: min(480px, calc(100% - 24px)); max-height: 70%; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); font-size: 12px; }
  .pop .ah { display: flex; flex-direction: column; gap: 2px; }
  .pop .re { display: flex; flex-direction: column; gap: 4px; }
  .pop .rr { display: flex; gap: 6px; align-items: center; }
  .pop .rr input { min-width: 0; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font-size: 12px; }
  .pop .rn { width: 96px; flex: none; }
  .pop .rp { flex: 1; }
  .pop textarea { resize: vertical; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font-family: var(--mono); font-size: 11.5px; }
  .pop .ab { display: flex; gap: 6px; align-items: center; }
  .pop .ab button { padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font-size: 11.5px; cursor: pointer; }
  .pop .ab button.ok { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
  .pop .ab button:disabled { opacity: .5; cursor: default; }
  .dim { color: var(--muted); font-size: 11.5px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .dot.claude { background: var(--preset-claude); }
  .dot.codex { background: var(--preset-codex); }
  .main { flex: 1; min-height: 0; display: flex; }
  .side { flex: none; width: 280px; display: flex; flex-direction: column; gap: 12px; padding: 24px 18px; border-left: 1px solid var(--border-soft); overflow-y: auto; }
  .lbl { color: var(--muted); font-size: 11px; letter-spacing: .04em; }
  .none { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .foot { margin-top: auto; padding-top: 8px; color: var(--muted); font-size: 11px; line-height: 1.6; }
  .lerr { display: block; margin-top: 6px; color: var(--warn); }
  .lerr button { margin-left: 4px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--fg); font-size: 11px; cursor: pointer; }
  @media (max-width: 760px) { .side { width: 220px; padding: 18px 12px; } }
</style>
