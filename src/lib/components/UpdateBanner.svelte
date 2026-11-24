<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 새 버전 알림: 지금 설치 / 일이 끝난 뒤 / 나중에. 누르기 전에는 아무것도 설치하지 않는다.
  import { upd, installNow, installWhenIdle, dismiss } from "$lib/updater.svelte";
  import { appUpdateDeps } from "$lib/updaterApp";
  import { working, background } from "$lib/stats.svelte";
  import { isBusy } from "$lib/updater.svelte";
  let busy = $derived(isBusy(working, background));
</script>

{#if upd.available}
  <div class="ub" role="status">
    <span>새 버전 <b>{upd.available}</b>이 있어요.</span>
    {#if upd.installing}
      <span class="dim">설치하는 중… 끝나면 다시 시작해요</span>
    {:else if upd.deferred}
      <span class="dim">일이 끝나면 설치하고 다시 시작해요</span>
      <button onclick={dismiss}>취소</button>
    {:else}
      <button class="pri" onclick={() => installNow(appUpdateDeps)}>{busy ? "지금 설치(하던 일 멈춤)" : "지금 설치"}</button>
      {#if busy}<button onclick={() => installWhenIdle(appUpdateDeps)}>일이 끝난 뒤</button>{/if}
      <button onclick={dismiss}>나중에</button>
    {/if}
    {#if upd.error}<span class="err">{upd.error}</span>{/if}
  </div>
{/if}

<style>
  .ub { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12.5px; background: var(--accent-soft, #2a3350); border-bottom: 1px solid var(--line, #333); }
  .ub button { font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--line, #444); background: transparent; color: inherit; cursor: pointer; }
  .ub .pri { background: var(--accent, #5b7cfa); border-color: transparent; color: #fff; }
  .dim { opacity: 0.7; }
  .err { color: var(--danger, #f66); }
</style>
