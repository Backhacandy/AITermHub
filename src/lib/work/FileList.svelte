<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 오른쪽 아래 만진 파일 목록: 고정 행 높이 + 스크롤, 최근에 만진 것이 위.
  import { relTime } from "./fileList";
  import { nowTick } from "$lib/stats.svelte";
  import type { Work } from "./work.svelte";

  let { work }: { work: Work } = $props();
  const VERB: Record<string, string> = { edit: "편집", read: "읽기", run: "실행" };
  let current = $derived(work.ui.follow ? work.ui.live : work.ui.selected);
</script>

<div class="fl">
  <div class="hd">만진 파일 <span class="n">{work.files.length}</span></div>
  <div class="list">
    {#each work.files as f (f.key)}
      <button class="row {f.status}" class:sel={current === f.key} title={f.path ?? f.label} onclick={() => work.select(f.key)}>
        <span class="ic" data-kind={f.kind}>{VERB[f.kind]}</span>
        <span class="nm">{f.label}</span>
        {#if f.writing}<span class="w">작성 중</span>
        {:else if f.binary}<span class="d">바이너리</span>
        {:else if f.status === "pending"}<span class="p">승인 대기</span>
        {:else if f.kind === "edit" && (f.added || f.removed)}<span class="d"><span class="a">+{f.added}</span> <span class="r">−{f.removed}</span></span>
        {:else if f.kind === "run"}<span class="d" class:bad={f.status === "error"}>{f.status === "running" ? "실행 중" : f.status === "done" ? "완료" : "실패"}</span>{/if}
        <span class="t">{relTime(f.touchedAt, nowTick.t)}</span>
      </button>
    {/each}
    {#if work.files.length === 0}<div class="empty">아직 만진 파일이 없어요.</div>{/if}
  </div>
</div>

<style>
  .fl { display: flex; flex-direction: column; height: 100%; min-height: 0; border-top: 1px solid var(--border); background: var(--bg-elev); }
  .hd { display: flex; gap: 6px; padding: 8px 12px 6px; color: var(--muted); font-size: 11.5px; font-weight: 600; }
  .n { color: var(--fg-dim); font-variant-numeric: tabular-nums; }
  .list { flex: 1; overflow-y: auto; padding: 0 6px 8px; }
  .row { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--fg); font-size: 12px; text-align: left; cursor: pointer; }
  .row:hover { background: var(--surface); }
  .row.sel { background: var(--surface-2); }
  .row.error .nm { color: var(--danger); }
  .row.rejected .nm { color: var(--muted); text-decoration: line-through; }
  .ic { flex: none; width: 28px; font-size: 11px; color: var(--muted); }
  .ic[data-kind="edit"] { color: var(--ok); }
  .ic[data-kind="run"] { color: var(--sleep); }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
  .d { flex: none; font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .d.bad { color: var(--danger); }
  .a { color: var(--ok); }
  .r { color: var(--danger); }
  .w { flex: none; font-size: 11px; color: var(--accent); }
  .p { flex: none; font-size: 11px; color: var(--warn); }
  .t { flex: none; width: 40px; text-align: right; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .empty { padding: 16px; text-align: center; color: var(--muted); font-size: 12px; }
</style>
