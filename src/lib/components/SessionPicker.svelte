<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 이 폴더의 Claude·Codex 대화 중 이어 갈 것을 직접 고른다(맨 위는 새 대화).
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import { sessionAgo, sessionLabel, type SessionInfo } from "$lib/work/sessionList";

  let { cli, cwd, current, onpick, onclose }: {
    cli: "claude" | "codex";
    cwd: string;
    current: string | null;
    onpick: (id: string | null) => void;
    onclose: () => void;
  } = $props();

  let list = $state<SessionInfo[] | null>(null);
  let err = $state("");
  const now = Date.now() / 1000;
  const mb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  onMount(() => {
    invoke<SessionInfo[]>(cli === "claude" ? "claude_sessions" : "codex_sessions", { cwd, limit: 30 })
      .then((l) => (list = l))
      .catch((e) => (err = String(e)));
  });
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKey} />
<div class="back" role="presentation" onclick={onclose}></div>
<div class="sp" role="dialog" aria-label="대화 고르기">
  <header><b>{cli === "claude" ? "Claude" : "Codex"} 대화 고르기</b><button class="x" onclick={onclose} aria-label="닫기">✕</button></header>
  <div class="list">
    <button class="row new" onclick={() => onpick(null)}>＋ 새 대화</button>
    {#if err}<div class="msg">{err}</div>
    {:else if !list}<div class="msg">불러오는 중…</div>
    {:else if !list.length}<div class="msg">이 폴더의 지난 대화가 없어요</div>
    {:else}
      {#each list as s (s.id)}
        <button class="row" class:cur={s.id === current} onclick={() => onpick(s.id)}>
          <span class="r1"><span class="nm">{sessionLabel(s)}</span>{#if s.id === current}<span class="tag">지금</span>{/if}<span class="meta">{sessionAgo(s.mtime, now)} · {mb(s.size)}</span></span>
          <span class="last">{s.last}</span>
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 40; }
  .sp { position: absolute; top: 34px; right: 8px; z-index: 41; width: min(460px, calc(100% - 16px)); max-height: 60%; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); }
  header { display: flex; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .x { margin-left: auto; border: none; background: none; color: var(--muted); cursor: pointer; }
  .list { overflow-y: auto; padding: 4px; }
  .row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 7px 8px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--fg); text-align: left; cursor: pointer; }
  .row:hover { background: var(--surface-2); }
  .row.cur { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .row.new { color: var(--accent); font-size: 12px; font-weight: 600; }
  .r1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .nm { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tag { flex: none; font-size: 10px; color: var(--accent); }
  .meta { margin-left: auto; flex: none; font-size: 10.5px; color: var(--muted); }
  .last { font-size: 11px; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg { padding: 12px; font-size: 12px; color: var(--muted); }
</style>
