<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 실제로 도움이 된 뒤(3번 이상 재우고 300MB 이상 돌려받은 뒤) 딱 한 번만 보이는 응원 부탁. 기능은 막지 않는다.
  import { invoke } from "@tauri-apps/api/core";
  import { ABOUT } from "$lib/about";
  import { shouldAsk, fmtGB } from "$lib/thanks";
  import { thanks, markAsked } from "$lib/thanksState.svelte";

  let show = $derived(shouldAsk(thanks.s));
  const go = (url: string) => {
    markAsked();
    invoke("open_path", { path: url }).catch(() => {});
  };
</script>

{#if show}
  <div class="tb" role="status">
    <span>지금까지 쉬는 탭을 <b>{thanks.s.sleeps}번</b> 재워 메모리 약 <b>{fmtGB(thanks.s.freed)}</b>를 돌려받았어요. 도움이 됐다면 응원해 주세요 🙌</span>
    <button class="pri" onclick={() => go(ABOUT.repo)}>GitHub ⭐</button>
    <button onclick={() => go(ABOUT.instagram)}>인스타 팔로우</button>
    <button onclick={markAsked}>닫기</button>
  </div>
{/if}

<style>
  .tb { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12.5px; background: var(--accent-soft, #2a3350); border-bottom: 1px solid var(--line, #333); }
  .tb span { margin-right: auto; }
  .tb button { font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--line, #444); background: transparent; color: inherit; cursor: pointer; }
  .tb .pri { background: var(--accent, #5b7cfa); border-color: transparent; color: #fff; }
</style>
