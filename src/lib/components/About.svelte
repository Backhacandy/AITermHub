<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 정보: 버전·저작권·라이선스·저장소·피드백·후원, 그리고 밖으로 연결하는 기능 목록
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getVersion } from "@tauri-apps/api/app";
  import { ABOUT, EXTERNAL, showSponsor } from "$lib/about";
  import { flavor } from "$lib/flavor";

  let version = $state("");
  onMount(() => void getVersion().then((v) => (version = v)).catch(() => {}));
  const open = (url: string) => invoke("open_path", { path: url }).catch(() => {});
</script>

<div class="about" data-build={ABOUT.marker}>
  <div class="t">{ABOUT.name} <span class="v">{version}{flavor() === "dev" ? " · 개발판" : ""}</span></div>
  <div class="dim">{ABOUT.copyright} · {ABOUT.license}</div>
  <div class="credit">
    <b>{ABOUT.credit}</b>
    <button onclick={() => open(ABOUT.authorInstagram)}>만든 사람 인스타</button>
    <button onclick={() => open(ABOUT.instagram)}>새 소식 @aitermhub</button>
  </div>
  <div class="links">
    <button onclick={() => open(ABOUT.repo)}>저장소</button>
    <button onclick={() => open(ABOUT.issues)}>버그 신고 · 제안</button>
    {#if showSponsor(ABOUT)}<button onclick={() => open(ABOUT.sponsor)}>후원하기</button>{/if}
  </div>
  <div class="sub">이 앱이 밖으로 연결하는 것 <span class="dim">(사용 통계는 보내지 않아요)</span></div>
  <ul>
    {#each EXTERNAL as e (e.name)}
      <li><b>{e.name}</b> — {e.where} · <span class="dim">{e.when}</span></li>
    {/each}
  </ul>
  <p class="dim">AGPL-3.0: 자유롭게 쓰고 고쳐도 돼요. 고친 버전을 배포하거나 서비스로 제공하면 그 소스도 같은 라이선스로 공개해야 해요.</p>
</div>

<style>
  .about { font-size: 12.5px; line-height: 1.6; }
  .t { font-weight: 600; font-size: 14px; }
  .v { font-weight: 400; opacity: 0.7; }
  .dim { opacity: 0.7; }
  .links { display: flex; gap: 6px; margin: 8px 0; }
  .links button { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--line, #444); background: transparent; color: inherit; cursor: pointer; }
  .sub { margin-top: 8px; font-weight: 600; }
  .credit { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 6px 10px; border-radius: 8px; background: var(--accent-soft, #2a3350); }
  .credit b { margin-right: auto; }
  .credit button { font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--line, #444); background: transparent; color: inherit; cursor: pointer; }
  ul { margin: 4px 0; padding-left: 18px; }
</style>
