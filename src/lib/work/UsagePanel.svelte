<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts" module>
  /** 이번 작업(턴) 토큰. input=새로 처리한 입력, cached=캐시에서 읽은 입력 */
  export interface TurnUsage {
    input: number;
    cached: number;
    output: number;
    running: boolean;
  }
</script>

<script lang="ts">
  // 오른쪽 패널 상단: 5시간·주간 한도, 컨텍스트, 이번 작업 토큰
  import { nowTick } from "$lib/stats.svelte";
  import { fmtReset, fmtTokens, limitDelta, type Limits } from "./limits";

  let {
    lim,
    before = null,
    ctxUsed,
    ctxLimit,
    turn = null,
  }: { lim: Limits | null; before?: Limits | null; ctxUsed: number; ctxLimit: number; turn?: TurnUsage | null } = $props();

  const pctOf = (used: number, total: number) => (total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0);
  const level = (p: number) => (p >= 85 ? "hot" : p >= 60 ? "warm" : "");

  let ctxPct = $derived(pctOf(ctxUsed, ctxLimit));
  let total = $derived(turn ? turn.input + turn.cached + turn.output : 0);
  // 이번 작업이 한도를 얼마나 올렸는지(5시간 우선, 없으면 주간)
  let delta = $derived.by(() => {
    if (!turn || turn.running) return null;
    const five = limitDelta(before?.fiveHour, lim?.fiveHour);
    if (five !== null) return { label: "5시간", v: five };
    const week = limitDelta(before?.weekly, lim?.weekly);
    return week !== null ? { label: "주간", v: week } : null;
  });
</script>

<div class="up">
  {#each [["5시간", lim?.fiveHour], ["주간", lim?.weekly]] as const as [name, w] (name)}
    {#if w}
      <div class="row">
        <span class="k">{name}</span>
        <div class="bar {level(w.pct)}"><div class="fill" style="width:{Math.min(100, w.pct)}%"></div></div>
        <span class="v">{Math.round(w.pct)}%</span>
        <span class="s">{fmtReset(w.resetsAt, nowTick.t)}</span>
      </div>
    {/if}
  {/each}
  {#if !lim?.fiveHour && !lim?.weekly}
    <div class="hint">사용 한도는 첫 응답 후 표시돼요</div>
  {/if}
  <div class="row">
    <span class="k">컨텍스트</span>
    <div class="bar {level(ctxPct)}"><div class="fill ctx" style="width:{ctxPct}%"></div></div>
    <span class="v">{ctxPct}%</span>
    <span class="s">{fmtTokens(ctxUsed)} / {fmtTokens(ctxLimit)}</span>
  </div>
  {#if turn}
    <div class="turn">
      <span class="k">이번 작업</span>
      {#if turn.running && total === 0}
        <span class="s">진행 중…</span>
      {:else}
        <b>{fmtTokens(total)}</b><span class="s">토큰 (입력 {fmtTokens(turn.input)}·캐시 {fmtTokens(turn.cached)}·출력 {fmtTokens(turn.output)})</span>
        {#if delta}<span class="d">· {delta.label} +{delta.v}%</span>{/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .up { display: flex; flex-direction: column; gap: 6px; padding: 2px 12px 10px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .row { display: grid; grid-template-columns: 52px 1fr 34px auto; align-items: center; gap: 8px; }
  .k { color: var(--muted); }
  .bar { height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .fill { height: 100%; background: var(--fg-dim); transition: width var(--ease); }
  .fill.ctx { background: var(--accent); }
  .bar.warm .fill { background: var(--warn); }
  .bar.hot .fill { background: var(--danger); }
  .v { text-align: right; color: var(--fg); }
  .s { color: var(--muted); white-space: nowrap; }
  .hint { color: var(--muted); }
  .turn { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin-top: 2px; padding-top: 7px; border-top: 1px solid var(--border-soft); }
  .turn .k { width: 52px; }
  .turn b { color: var(--fg); font-size: 12px; font-weight: 600; }
  .d { color: var(--warn); }
</style>
