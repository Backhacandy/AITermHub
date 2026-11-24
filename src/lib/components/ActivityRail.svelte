<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import type { View } from "$lib/types";
  import { settings } from "$lib/settings.svelte";
  import Icon from "./Icon.svelte";
  import { multiAccount } from "$lib/flavor";

  let {
    view,
    onview,
    onsettings,
  }: {
    view: View;
    onview: (v: View) => void;
    onsettings: () => void;
  } = $props();

  function pick(v: Exclude<View, null>) {
    onview(view === v ? null : v);
  }
  // 항목은 꼭 필요한 것만: 탐색기 · 현황(세션 상태+메모리) · 계정 · 추천. 모바일 원격은 폴더를 연결해 썼을 때만
  let items = $derived<{ v: Exclude<View, null>; icon: string; label: string }[]>([
    { v: "files", icon: "files", label: "탐색기" },
    { v: "status", icon: "status", label: "현황 · 세션과 메모리" },
    { v: "accounts", icon: "user", label: multiAccount() ? "계정 · 한도" : "사용량 · 한도" },
    { v: "reco", icon: "hint", label: "추천 · 찾기" },
    ...(settings.mobileOn || settings.remoteDirs?.length ? [{ v: "mobile" as const, icon: "phone", label: "모바일 원격" }] : []),
  ]);
</script>

<nav class="rail" aria-label="도구">
  <div class="logo" title="AI Terminal Hub" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M7.5 10l2.5 2-2.5 2M12 14.5h4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </div>
  {#each items as it (it.v)}
    <button class="rbtn" class:on={view === it.v} title={it.label} aria-label={it.label} aria-pressed={view === it.v} onclick={() => pick(it.v)}>
      <Icon name={it.icon} size={18} />
    </button>
  {/each}
  <div class="sep"></div>
  <div class="spacer"></div>
  <button class="rbtn" title="설정" aria-label="설정" onclick={onsettings}><Icon name="settings" size={18} /></button>
</nav>

<style>
  .rail {
    width: 48px;
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 10px 0;
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
  }
  .logo {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    color: var(--fg);
    margin-bottom: 10px;
  }
  .rbtn {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    position: relative;
  }
  .rbtn:hover { color: var(--fg); background: var(--surface-2); }
  .rbtn.on { color: var(--fg); background: var(--surface-2); }
  .rbtn.on::before {
    content: "";
    position: absolute;
    left: -7px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .sep { width: 20px; height: 1px; background: var(--border); margin: 6px 0; }
  .spacer { flex: 1; }
</style>
