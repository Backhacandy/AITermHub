<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import FileTree from "./FileTree.svelte";
  import SessionStatus from "./SessionStatus.svelte";
  import MemoryBar from "./MemoryBar.svelte";
  import Recommendations from "./Recommendations.svelte";
  import AccountsPanel from "./AccountsPanel.svelte";
  import MobilePanel from "./MobilePanel.svelte";
  import type { View } from "$lib/types";
  import Splitter from "./Splitter.svelte";
  import { layout, setLayout, resetLayout } from "$lib/layout.svelte";

  let { view, cwd, onclose }: { view: View; cwd?: string; onclose: () => void } = $props();

  let panel: HTMLElement;
  // 패널 오른쪽 끝에서 포인터까지 = 너비
  function drag(e: PointerEvent) {
    const r = panel.getBoundingClientRect();
    setLayout("sidePanelPx", r.right - e.clientX, 200, Math.max(240, window.innerWidth * 0.6));
  }
</script>

<aside class="rp" bind:this={panel} style="width:{layout.sidePanelPx}px">
  <Splitter dir="x" ondrag={drag} onreset={() => resetLayout("sidePanelPx")} style="left:0" />
  {#if view === "files"}
    <FileTree {cwd} />
  {:else if view === "status"}
    <div class="stack">
      <div class="part"><SessionStatus /></div>
      <div class="part"><MemoryBar {onclose} /></div>
    </div>
  {:else if view === "reco"}
    <Recommendations {cwd} />
  {:else if view === "accounts"}
    <AccountsPanel />
  {:else if view === "mobile"}
    <MobilePanel />
  {/if}
</aside>

<style>
  .stack { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .stack .part { flex: 1; min-height: 0; overflow: auto; }
  .stack .part + .part { border-top: 1px solid var(--border-soft); }
  .rp {
    position: relative;
    flex: none;
    height: 100%;
    background: var(--bg-elev);
    border-left: 1px solid var(--border-soft);
    overflow: hidden;
  }
</style>
