<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 에이전트 카드: 채팅 없이 상태 점 · 이름 · 모델 · 지금 하는 일 한 줄. 펼치면 마지막 인계·바뀐 파일·모델 설정.
  import { LANE_MODELS, EFFORTS, modelLabel } from "$lib/pair/models";
  import { STATE_LABEL, type AgentState } from "$lib/team/agentStatus";

  let {
    name,
    cli,
    model,
    effort,
    purpose,
    state,
    activity,
    handoff,
    error = "",
    quiet = 0,
    files,
    open,
    detail = true,
    ontoggle,
    onmodel,
    oneffort,
    onpick,
    onremove,
  }: {
    name: string;
    cli: "claude" | "codex";
    model: string;
    effort?: string;
    purpose: string;
    state: AgentState;
    activity: string;
    handoff: string;
    /** 멈춰 있을 때 마지막 오류 글 */
    error?: string;
    /** 출력 없이 조용한 지 몇 분(0 = 정상) — 일하는 중인데 멈춘 것 같으면 그렇게 보인다 */
    quiet?: number;
    files: string[];
    open: boolean;
    /** 모델·생각 선택을 보일지(맥스에서만) */
    detail?: boolean;
    ontoggle: () => void;
    onmodel: (m: string) => void;
    oneffort: (e: string) => void;
    onpick: () => void;
    onremove?: () => void;
  } = $props();

  const busy = $derived(state === "work");
  const stuck = $derived(quiet > 0 && (state === "work" || state === "bg"));
</script>

<div class="card" class:open>
  <button class="top" onclick={ontoggle} aria-expanded={open}>
    <span class="dot {stuck ? 'stuck' : state}" title={stuck ? "응답 없음" : STATE_LABEL[state]}></span>
    <span class="main">
      <span class="n">{name}<span class="m">{model === "auto" ? "자동" : modelLabel(cli, model)}</span></span>
      <span class="t" class:warn={stuck}>{stuck ? `응답 없음 · ${quiet}분째 — 제한 시간을 넘기면 앱이 멈추고 이어서 하게 해요` : activity || (state === "rest" ? purpose || STATE_LABEL.rest : STATE_LABEL[state])}</span>
    </span>
  </button>
  {#if open}
    <div class="more">
      {#if purpose}<div class="row"><span class="k">맡은 일</span><span>{purpose}</span></div>{/if}
      {#if error}<div class="err">{error}</div>{/if}
      <div class="sec">마지막 인계</div>
      <div class="hand">{handoff || "아직 없음"}</div>
      {#if files.length}
        <div class="sec">바뀐 파일</div>
        <div class="files">{#each files.slice(0, 8) as f (f)}<code title={f}>{f.split(/[\\/]/).pop()}</code>{/each}{#if files.length > 8}<span class="k">외 {files.length - 8}개</span>{/if}</div>
      {/if}
      {#if detail}
      <div class="ctl">
        <select title="모델" value={model} disabled={busy} onchange={(e) => onmodel((e.currentTarget as HTMLSelectElement).value)}>
          {#each LANE_MODELS[cli] as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
        </select>
        <select title="생각 깊이" value={effort ?? ""} disabled={busy} onchange={(e) => oneffort((e.currentTarget as HTMLSelectElement).value)}>
          {#each EFFORTS[cli] as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
        </select>
      </div>
      {/if}
      <div class="ctl">
        <button disabled={busy} onclick={onpick}>대화 고르기</button>
        {#if onremove}<button class="rm" disabled={busy} onclick={onremove}>빼기</button>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .card { border: 1px solid var(--border-soft); border-radius: 12px; background: var(--surface); }
  .card.open { border-color: var(--border); }
  .top { display: flex; gap: 11px; align-items: flex-start; width: 100%; padding: 12px 13px; border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .dot { position: relative; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; flex: none; background: var(--muted); }
  /* 번지는 빛은 따로 그려 두고 투명도만 바꾼다 — box-shadow를 움직이면 매 프레임 다시 그려 화면 CPU·GPU를 계속 쓴다 */
  .dot.work::after, .dot.bg::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; background: color-mix(in srgb, currentColor 22%, transparent); will-change: opacity; }
  .dot.work { background: var(--ok); color: var(--ok); }
  .dot.work::after { animation: glow 1.6s ease-in-out infinite; }
  .dot.wait { background: var(--warn); }
  .dot.stuck { background: var(--warn); }
  .t.warn { color: var(--warn); }
  .dot.bg { background: var(--accent); color: var(--accent); }
  .dot.bg::after { animation: glow 2.8s ease-in-out infinite; }
  .dot.prep { opacity: 0.4; }
  .dot.error { background: var(--danger); }
  @keyframes glow { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .n { font-size: 13px; font-weight: 600; color: var(--fg); }
  .m { margin-left: 6px; color: var(--muted); font-size: 11px; font-weight: 400; }
  .t { color: var(--fg-dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .more { display: flex; flex-direction: column; gap: 8px; padding: 0 13px 13px 32px; font-size: 12px; }
  .row { display: flex; gap: 8px; line-height: 1.5; }
  .k { flex: none; color: var(--muted); font-size: 11.5px; }
  .sec { margin-top: 2px; color: var(--muted); font-size: 11px; }
  .err { padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); line-height: 1.5; white-space: pre-wrap; }
  .hand { white-space: pre-wrap; line-height: 1.55; color: var(--fg-dim); max-height: 160px; overflow-y: auto; }
  .files { display: flex; flex-wrap: wrap; gap: 5px; }
  .files code { padding: 1px 6px; border-radius: 6px; background: var(--surface-2); font-family: var(--mono); font-size: 11px; }
  .ctl { display: flex; gap: 6px; flex-wrap: wrap; }
  .ctl select, .ctl button { height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); font-size: 11.5px; }
  .ctl button { cursor: pointer; }
  .ctl button:disabled, .ctl select:disabled { opacity: 0.5; cursor: default; }
  .ctl .rm:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
</style>
