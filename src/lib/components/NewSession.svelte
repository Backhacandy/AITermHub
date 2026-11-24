<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 새로 만들기: ① 무엇을(팀·Claude·Codex·터미널) ② 폴더 ③ 팀이면 라이트·맥스. 나머지 옵션은 "자세히"에 접는다.
  // 새 팀은 팀장 하나로 시작한다(자세히에서 에이전트를 직접 넣거나 AI 제안을 받을 수 있다).
  import { untrack } from "svelte";
  import { open, ask } from "@tauri-apps/plugin-dialog";
  import { addSession, addClaude, addCodex, addTeam, tabs, ROLE_LABELS, type Preset, type Role } from "$lib/sessions.svelte";
  import { teamEnabled } from "$lib/experimental";
  import { settings, saveSettings } from "$lib/settings.svelte";
  import { LANE_MODELS, EFFORTS, AUTO } from "$lib/pair/models";
  import { detectAreas, ROLE_LABEL } from "$lib/pair/route";
  import { rowsFor, hqMax, type Row } from "$lib/team/team";
  import { teamDraft } from "$lib/team/draft";
  import { MODES, type TeamMode } from "$lib/team/mode";
  import { scanDirs, readDir } from "$lib/team/scan";
  import { normalizeProposal, proposePrompt, PROPOSE_SCHEMA, PROPOSE_SYSTEM } from "$lib/team/distribute";
  import { quickJson, PROPOSE_MODEL } from "$lib/team/oneshot";

  let { initialPreset = "claude" as Preset, onclose }: { initialPreset?: Preset; onclose: () => void } =
    $props();

  const init = untrack(() => initialPreset);
  /** 무엇을: 팀 · 한 명(Claude·Codex) · 터미널 */
  /** 팀은 실험 기능(설정에서 켰거나 이미 팀 탭이 있을 때만) */
  const teamOn = teamEnabled(settings, tabs.filter((t) => t.kind === "pair").length);
  let kind = $state<"team" | "claude" | "codex" | "powershell">(init === "powershell" ? "powershell" : init === "codex" ? "codex" : teamOn ? "team" : "claude");
  /** 팀 운영 방식 */
  let teamMode = $state<TeamMode>(settings.defaultMode ?? "lite");
  /** 자세히(나머지 옵션) */
  let more = $state(false);
  let cwd = $state<string>(settings.lastCwd ?? "");

  // ---------- 에이전트 수·줄 ----------
  const MAX_ROWS = 8;
  let aiMode = $state(false);
  /** 팀: 직접 넣을 에이전트(비면 팀장 하나로 시작) · 한 명: 그 에이전트 한 줄 */
  let rows = $state<Row[]>([]);
  let single = $derived(kind === "claude" || kind === "codex");
  let team = $derived(kind === "team");
  /** 무엇을 바꾸면 줄을 맞춘다 */
  function pickKind(k: typeof kind) {
    kind = k;
    aiMode = false;
    rows = k === "claude" || k === "codex" ? [{ name: "", cli: k, model: AUTO, purpose: "", areas: [] }] : [];
  }
  pickKind(untrack(() => kind));

  // ---------- 팀: 에이전트 직접 넣기 ----------
  function setCount(n: number) {
    aiMode = false;
    rows = rowsFor(n, $state.snapshot(rows) as Row[]);
  }
  function removeRow(i: number) {
    rows = rows.filter((_, j) => j !== i);
  }
  function addRow() {
    if (rows.length >= MAX_ROWS) return;
    rows = rowsFor(rows.length + 1, $state.snapshot(rows) as Row[]);
  }
  const areaText = (r: Row) => r.areas.join(", ");
  const setAreas = (r: Row, t: string) => (r.areas = t.split(/[\r\n,]+/).map((x) => x.trim()).filter(Boolean));

  // ---------- AI가 정함 ----------
  let goal = $state("");
  let proposing = $state(false);
  /** 목적대로 바로 시작: AI가 에이전트마다 첫 작업 지시까지 쓰고, 팀이 열리자마자 보낸다 */
  let startNow = $state(false);
  /** AI가 정할 때 쓸 AI(null = 둘 다) */
  let only = $state<"claude" | "codex" | null>(null);
  let propErr = $state("");
  function startAi() {
    aiMode = true;
    propErr = "";
    rows = [];
  }
  async function propose() {
    if (!goal.trim() || !cwd) return;
    proposing = true;
    propErr = "";
    const dirs = await scanDirs(cwd, readDir).catch(() => [] as string[]);
    const res = await quickJson<unknown>(cwd, PROPOSE_SYSTEM, proposePrompt(goal.trim(), dirs, [], startNow, only), PROPOSE_SCHEMA, PROPOSE_MODEL);
    proposing = false;
    const list = res ? normalizeProposal(res, [], only) : [];
    if (!list.length) {
      propErr = "제안을 받지 못했어요. 목적을 조금 더 구체적으로 적거나 인원을 직접 골라 주세요";
      return;
    }
    rows = list.map((d) => ({ name: d.name, cli: d.cli, model: d.model, effort: d.effort, purpose: d.purpose, areas: d.areas, task: d.task }));
  }

  // ---------- 1명(단일 탭) 옵션 ----------
  let mode = $state<"term" | "structured">("term");
  // 경량(--bare)은 구독 로그인을 쓰지 않아 화면에서 뺐다(늘 끔)
  const bare = false;
  let start = $state<"new" | "continue" | "resume">("new");
  let modelCustom = $state("");
  // 설정의 "에이전트 전체 권한"이 켜져 있으면 처음부터 전체 권한이 선택돼 있다(바꿀 수 있음)
  let perm = $state<"default" | "acceptEdits" | "plan" | "skip">(settings.fullAccess ? "skip" : "default");
  let approval = $state<"" | "on-request" | "on-failure" | "never">(settings.fullAccess ? "never" : "");
  let sandbox = $state<"" | "read-only" | "workspace-write" | "danger-full-access">(settings.fullAccess ? "danger-full-access" : "");
  let role = $state<Role>(null);
  let extra = $state("");

  let preset = $derived<Preset>(kind === "powershell" ? "powershell" : kind === "codex" ? "codex" : "claude");
  /** 단일 탭 모델 인자("" = CLI 기본) */
  let model = $derived(!rows[0] || rows[0].model === AUTO ? "" : rows[0].model === "custom" ? modelCustom.trim() : rows[0].model);
  let effort = $derived(rows[0]?.effort ?? "");

  async function pickFolder() {
    const dir = await open({ directory: true, defaultPath: cwd || undefined });
    if (typeof dir === "string") cwd = dir;
  }

  function buildArgs(): { title: string; program: string; args: string[] } {
    if (preset === "powershell") return { title: "PowerShell", program: "powershell.exe", args: [] };
    const cli = preset;
    const a: string[] = ["/k", cli];
    if (preset === "claude") {
      if (start === "continue") a.push("-c");
      else if (start === "resume") a.push("-r");
      if (model) a.push("--model", model);
      if (effort) a.push("--effort", effort);
      if (perm === "skip") a.push("--dangerously-skip-permissions");
      else if (perm !== "default") a.push("--permission-mode", perm);
    } else {
      if (start === "continue") a.push("resume", "--last");
      else if (start === "resume") a.push("resume");
      if (model) a.push("-m", model);
      if (effort) a.push("-c", `model_reasoning_effort=${effort}`);
      if (approval) a.push("-a", approval);
      if (sandbox) a.push("-s", sandbox);
    }
    if (extra.trim()) a.push(...extra.trim().split(/\s+/));
    return { title: cli === "claude" ? "Claude" : "Codex", program: "cmd.exe", args: a };
  }

  let preview = $derived.by(() => {
    if (team) return `팀 — 팀장(${MODES[teamMode].label} · ${MODES[teamMode].leadModel})${rows.length ? ` + 에이전트 ${rows.length}명` : " 하나로 시작 · 팀장이 필요한 에이전트를 만들어요"}`;
    if (mode === "structured" && preset !== "powershell") return `${preset === "claude" ? "Claude" : "Codex"} 구조화 세션 — 왼쪽 대화 / 오른쪽 작업현황`;
    const { program, args } = buildArgs();
    return [program, ...args].join(" ");
  });

  let canLaunch = $derived(kind === "powershell" || single || (team && !!cwd && !proposing));

  async function launchTeam() {
    const key = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const needAreas = rows.some((r) => !r.areas.length && (r.purpose === ROLE_LABEL.front || r.purpose === ROLE_LABEL.back));
    const areas = needAreas ? (settings.pairAreas?.[key] ?? detectAreas(await scanDirs(cwd, readDir).catch(() => []))) : { front: [], back: [] };
    const list = $state.snapshot(rows) as Row[];
    const team = teamDraft(list, teamMode, areas);
    // 바로 시작: 목적을 팀장에게(팀장이 나눠 맡긴다)
    addTeam(cwd, team, aiMode && startNow && goal.trim() ? { goal: goal.trim(), tasks: {} } : null);
  }

  async function launch() {
    if (!canLaunch) return;
    // 설정에서 이미 전체 권한을 허락했으면 다시 묻지 않는다
    if (single && preset === "claude" && perm === "skip" && !settings.fullAccess) {
      const ok = await ask("모든 도구(명령 실행·파일 삭제 포함)를 확인 없이 실행합니다. 계속할까요?", {
        title: "모두 건너뛰기", kind: "warning",
      }).catch(() => false);
      if (!ok) return;
    }
    if (cwd) { settings.lastCwd = cwd; saveSettings(); }

    if (team && teamMode === "max") {
      const ok = await ask("맥스로 만든 팀은 나중에 라이트로 바꿀 수 없어요.\n라이트로 만들면 나중에 맥스로 바꿀 수 있어요. 맥스로 만들까요?", {
        title: "맥스로 만들기", kind: "warning", okLabel: "맥스로 만들기", cancelLabel: "돌아가기",
      }).catch(() => false);
      if (!ok) return;
    }
    if (team) {
      await launchTeam();
      onclose();
      return;
    }
    const cont = start === "continue";
    if (mode === "structured" && preset === "claude") {
      const permMap: Record<string, string> = { skip: "bypassPermissions" };
      addClaude(cwd || undefined, model || undefined, permMap[perm] ?? perm, cont, bare, effort || undefined);
    } else if (mode === "structured" && preset === "codex") {
      addCodex(cwd || undefined, model || undefined, sandbox || "workspace-write", approval || "on-request", cont, effort || undefined);
    } else {
      const { title, program, args } = buildArgs();
      addSession({ title, preset, program, args, cwd: cwd || undefined, model: model || undefined, role });
    }
    onclose();
  }
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="새 세션">
    <header><span>새로 만들기</span><button class="x" onclick={onclose}>×</button></header>

    <div class="body">
      <div class="step"><span class="no">1</span>무엇을</div>
      <div class="seg four">
        {#if teamOn}<button class:on={kind === "team"} onclick={() => pickKind("team")}><span class="dot" data-preset="claude"></span><span class="dot" data-preset="codex"></span>팀</button>{/if}
        <button class:on={kind === "claude"} onclick={() => pickKind("claude")}><span class="dot" data-preset="claude"></span>Claude</button>
        <button class:on={kind === "codex"} onclick={() => pickKind("codex")}><span class="dot" data-preset="codex"></span>Codex</button>
        <button class:on={kind === "powershell"} onclick={() => pickKind("powershell")}><span class="dot" data-preset="powershell"></span>터미널</button>
      </div>

      <div class="step"><span class="no">2</span>폴더</div>
      <div class="pick">
        <input bind:value={cwd} placeholder={team ? "팀은 폴더가 필요해요" : "비우면 기본 폴더"} />
        <button onclick={pickFolder}>폴더 선택</button>
      </div>

      {#if team}
        <div class="step"><span class="no">3</span>운영 방식</div>
        <div class="seg">
          <button class:on={teamMode === "lite"} onclick={() => (teamMode = "lite")}><span class="mt">라이트</span><span class="md">토큰 아끼기 · 팀장 Sonnet · 최대 4명</span></button>
          <button class:on={teamMode === "max"} onclick={() => (teamMode = "max")}><span class="mt">맥스</span><span class="md">품질·속도 · 팀장 Opus · 합치기 전 검증</span></button>
        </div>
      {/if}

      {#if kind !== "powershell"}
        <button class="more-btn" onclick={() => (more = !more)}>자세히 {more ? "▾" : "▸"}</button>
      {/if}

      {#if more && team}
        <div class="field">
          <span class="lbl">에이전트</span>
          <div class="chips">
            <button class="chip" class:on={!aiMode && rows.length === 0} onclick={() => { aiMode = false; rows = []; }}>팀장만</button>
            {#each [1, 2, 3, 4, 5, 6] as n (n)}
              <button class="chip" class:on={!aiMode && rows.length === n} onclick={() => setCount(n)}>{n}명</button>
            {/each}
            <button class="chip" class:on={aiMode} onclick={startAi}>AI가 정함</button>
          </div>
        </div>

        {#if aiMode}
          <div class="field">
            <span class="lbl">목적</span>
            <div class="col">
              <textarea rows="2" bind:value={goal} placeholder="예: 결제·로그인·마이페이지 화면을 빨리 만들고 싶어"></textarea>
              <div class="ai-row">
                <span class="dim">{cwd ? "AI(Opus)가 폴더를 보고 인원과 각자 맡을 일·경로·모델·생각 깊이를 제안해요. 고친 뒤 실행하세요" : "먼저 프로젝트 폴더를 골라 주세요"}</span>
                <select class="only" bind:value={only} title="AI가 정할 때 이 AI만 쓰게 해요">
                  <option value={null}>둘 다</option>
                  <option value="claude">Claude만</option>
                  <option value="codex">Codex만</option>
                </select>
                <button class="mini ok" disabled={proposing || !goal.trim() || !cwd} onclick={propose}>{proposing ? "제안 받는 중…" : "제안 받기"}</button>
              </div>
              <label class="chk"><input type="checkbox" bind:checked={startNow} /> 목적대로 바로 시작 <span class="dim">— 팀이 열리면 이 목적을 팀장에게 보내요</span></label>
              {#if propErr}<div class="err">{propErr}</div>{/if}
            </div>
          </div>
        {/if}
      {/if}

      {#if (more && team) || (more && single)}
        {#if rows.length}
          <div class="rows">
            {#each rows as r, i (i)}
              <div class="row" class:solo={single}>
                <div class="line">
                  {#if team}
                    <select title="에이전트" bind:value={r.cli} onchange={() => { r.model = AUTO; r.effort = undefined; }}>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                    </select>
                  {/if}
                  <select title="모델" bind:value={r.model}>
                    {#each LANE_MODELS[r.cli] as m (m.id)}<option value={m.id}>{single && m.id === AUTO ? "기본 모델" : m.label}</option>{/each}
                    {#if single}<option value="custom">직접 입력</option>{/if}
                  </select>
                  <select title="생각 깊이 · 기본이면 CLI 설정 파일 값" value={r.effort ?? ""} onchange={(e) => (r.effort = (e.currentTarget as HTMLSelectElement).value || undefined)}>
                    {#each EFFORTS[r.cli] as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
                  </select>
                  {#if team}
                    <input class="nm" bind:value={r.name} placeholder={r.cli === "claude" ? "Claude" : "Codex"} title="이름(@이름으로 부름)" />
                    <button class="rm" title="빼기" aria-label="빼기" onclick={() => removeRow(i)}>✕</button>
                  {/if}
                </div>
                {#if single && r.model === "custom"}
                  <input class="full" bind:value={modelCustom} placeholder="모델 이름 직접 입력 · 예: opus[1m]" />
                {/if}
                {#if team}
                  <div class="line">
                    <input class="grow" bind:value={r.purpose} placeholder="맡을 일" />
                    <input class="grow mono" value={areaText(r)} oninput={(e) => setAreas(r, (e.currentTarget as HTMLInputElement).value)} placeholder={r.purpose === ROLE_LABEL.front || r.purpose === ROLE_LABEL.back ? "담당 경로 · 비우면 폴더를 보고 자동" : "담당 경로(쉼표로) · 선택"} />
                  </div>
                {/if}
              </div>
            {/each}
            {#if team && rows.length < MAX_ROWS}
              <button class="more" onclick={addRow}>＋ 한 명 더</button>
            {/if}
          </div>
        {/if}
        {#if team}
          <div class="note">권한은 설정의 "에이전트 전체 권한"을 따르고, 한꺼번에 도는 건 {hqMax()}명까지예요(넘으면 차례로).</div>
        {/if}
      {/if}

      {#if more && single}
          <div class="field">
            <span class="lbl">모드</span>
            <div class="chips">
              <button class="chip" class:on={mode === "term"} onclick={() => (mode = "term")}>터미널</button>
              <button class="chip" class:on={mode === "structured"} onclick={() => (mode = "structured")}>구조화</button>
            </div>
          </div>

          {#if mode === "structured" && start === "continue"}
            <div class="warn-note">"이어서"는 지난 대화 전체를 다시 올려 토큰이 많이 듭니다. 큰 폴더에선 "새로"를 권장.</div>
          {/if}

          <div class="field">
            <span class="lbl">시작</span>
            <div class="chips">
              {#each [["new","새로"],["continue", preset==="claude"?"이어서 -c":"이어서 --last"],["resume","세션 선택"]] as [v,l] (v)}
                <button class="chip" class:on={start===v} onclick={() => (start = v as any)}>{l}</button>
              {/each}
            </div>
          </div>

          {#if preset === "claude"}
            <div class="field">
              <span class="lbl">권한</span>
              <div class="chips">
                {#each [["default","기본"],["acceptEdits","편집 자동수락"],["plan","계획"],["skip","모두 건너뛰기"]] as [v,l] (v)}
                  <button class="chip" class:on={perm===v} class:warn={v==="skip"} onclick={() => (perm=v as any)}>{l}</button>
                {/each}
              </div>
            </div>
          {:else}
            <div class="field">
              <span class="lbl">승인</span>
              <div class="chips">
                {#each [["","기본"],["on-request","요청 시"],["on-failure","실패 시"],["never","자동"]] as [v,l] (v)}
                  <button class="chip" class:on={approval===v} onclick={() => (approval=v as any)}>{l}</button>
                {/each}
              </div>
            </div>
            <div class="field">
              <span class="lbl">샌드박스</span>
              <div class="chips">
                {#each [["","기본"],["read-only","읽기전용"],["workspace-write","작업공간쓰기"],["danger-full-access","전체허용"]] as [v,l] (v)}
                  <button class="chip" class:on={sandbox===v} onclick={() => (sandbox=v as any)}>{l}</button>
                {/each}
              </div>
            </div>
          {/if}

          {#if mode === "term"}
            <div class="field">
              <span class="lbl">역할</span>
              <div class="chips">
                <button class="chip" class:on={role===null} onclick={() => (role=null)}>없음</button>
                {#each Object.entries(ROLE_LABELS) as [v,l] (v)}
                  <button class="chip" class:on={role===v} onclick={() => (role=v as Role)}>{l}</button>
                {/each}
              </div>
            </div>

            <div class="field">
              <span class="lbl">추가 인자</span>
              <input class="sm" bind:value={extra} placeholder="고급 · 예: --verbose" />
            </div>
          {/if}
      {/if}

      <div class="preview" title="실행될 명령">{preview}</div>
    </div>

    <footer>
      <button class="cancel" onclick={onclose}>취소</button>
      <button class="go" disabled={!canLaunch} onclick={launch}>실행</button>
    </footer>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 55; }
  .modal { width: 580px; max-width: 94vw; max-height: 90vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
  header { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; border-bottom: 1px solid var(--border-soft); font-weight: 700; font-size: 15px; }
  .x { border: none; background: transparent; color: var(--muted); font-size: 20px; cursor: pointer; }
  .body { padding: 20px 24px; overflow-y: auto; }
  .step { display: flex; align-items: center; gap: 8px; margin: 4px 0 10px; color: var(--fg-dim); font-size: 12.5px; font-weight: 600; }
  .step .no { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-size: 11px; }
  .seg.four button { padding: 12px 8px; }
  .seg button .mt { font-weight: 600; color: var(--fg); }
  .seg button .md { color: var(--muted); font-size: 11.5px; }
  .seg button:has(.mt) { flex-direction: column; gap: 3px; }
  .more-btn { display: block; margin: 4px 0 14px; padding: 0; border: none; background: none; color: var(--muted); font-size: 12px; cursor: pointer; }
  .more-btn:hover { color: var(--fg); }
  .seg { display: flex; gap: 8px; margin-bottom: 22px; }
  .seg button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elev); color: var(--muted); font-size: 13px; cursor: pointer; }
  .seg button .dot + .dot { margin-left: -4px; }
  .seg button.on { border-color: var(--accent); color: var(--fg); background: var(--accent-soft); }
  .lbl { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; min-width: 64px; }
  .pick { display: flex; gap: 6px; margin-bottom: 22px; }
  .pick input { flex: 1; }
  input, select, textarea { padding: 8px 10px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); font-size: 13px; font-family: inherit; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { resize: vertical; }
  .pick button { padding: 8px 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--fg); cursor: pointer; white-space: nowrap; }
  .field { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
  .field .lbl { margin: 6px 0 0; flex: none; width: 64px; }
  .field .sm { flex: 1; }
  .col { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ai-row { display: flex; align-items: center; gap: 8px; }
  .ai-row .dim { flex: 1; }
  .ai-row .only { flex: none; height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font-size: 11.5px; }
  .dim { color: var(--muted); font-size: 11.5px; }
  .err { color: var(--danger); font-size: 12px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 6px 11px; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-elev); color: var(--muted); font-size: 12px; cursor: pointer; }
  .chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .chip.warn.on { border-color: var(--danger); color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .row { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--bg-elev); }
  .row.solo { padding: 0; border: none; background: none; }
  .line { display: flex; gap: 6px; align-items: center; }
  .line select, .line input, .row .full { padding: 6px 8px; font-size: 12px; background: var(--bg); }
  .line .nm { width: 96px; flex: none; }
  .line .grow { flex: 1; min-width: 0; }
  .mono { font-family: var(--mono); font-size: 11.5px !important; }
  .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg); cursor: pointer; }
  .chk input { margin: 0; }
  .rm { margin-left: auto; border: none; background: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .rm:hover:not(:disabled) { color: var(--danger); }
  .rm:disabled { opacity: .3; cursor: default; }
  .more { align-self: flex-start; padding: 5px 12px; border: 1px dashed var(--border); border-radius: var(--radius-sm); background: none; color: var(--muted); font-size: 12px; cursor: pointer; }
  .more:hover { color: var(--fg); border-color: var(--accent); }
  .mini { padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--fg); font-size: 12px; cursor: pointer; white-space: nowrap; }
  .mini.ok { background: var(--accent); border-color: var(--accent); color: #fff; }
  .mini:disabled { opacity: .5; cursor: default; }
  .note { margin: -4px 0 12px; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
  .warn-note { margin: -4px 0 12px; padding: 8px 10px; font-size: 11.5px; color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); border-radius: 8px; line-height: 1.5; }
  .preview { margin-top: 10px; padding: 10px 12px; background: var(--bg-elev); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); color: var(--accent-2); font-family: var(--mono); font-size: 11.5px; word-break: break-all; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px; border-top: 1px solid var(--border-soft); }
  footer button { padding: 9px 20px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--fg); }
  .go { background: var(--accent); color: #fff; border-color: var(--accent); }
  .go:disabled { opacity: .5; cursor: default; }
</style>
