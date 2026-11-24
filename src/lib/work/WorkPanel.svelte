<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 오른쪽 패널: (화면별 헤더) + 라이브 뷰 + 파일 목록.
  // 왼쪽 경계를 끌면 패널 너비, 라이브/목록 사이를 끌면 높이 비율이 바뀐다(모든 탭 공통·저장됨).
  import type { Snippet } from "svelte";
  import LiveView from "./LiveView.svelte";
  import FileList from "./FileList.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import { layout, setLayout, resetLayout } from "$lib/layout.svelte";
  import type { Work } from "./work.svelte";

  let { work, header, onrequest }: { work: Work; header?: Snippet; onrequest?: (text: string) => void } = $props();

  let panel: HTMLDivElement;
  let body: HTMLDivElement;

  // 화면(부모) 오른쪽 끝에서 포인터까지 = 패널 너비
  function dragWidth(e: PointerEvent) {
    const view = panel.parentElement?.getBoundingClientRect();
    if (!view || view.width === 0) return;
    setLayout("workPanelPct", ((view.right - e.clientX) / view.width) * 100, 22, 78);
  }
  function dragLive(e: PointerEvent) {
    const r = body.getBoundingClientRect();
    if (r.height === 0) return;
    setLayout("livePct", ((e.clientY - r.top) / r.height) * 100, 12, 88);
  }
</script>

<div class="wp" bind:this={panel} style="width:{layout.workPanelPct}%">
  <Splitter dir="x" ondrag={dragWidth} onreset={() => resetLayout("workPanelPct")} style="left:0" />
  {#if header}<div class="top">{@render header()}</div>{/if}
  <div class="body" bind:this={body}>
    <div class="live" style="height:{layout.livePct}%"><LiveView {work} {onrequest} /></div>
    <Splitter dir="y" ondrag={dragLive} onreset={() => resetLayout("livePct")} style="top:{layout.livePct}%" />
    <div class="files"><FileList {work} /></div>
  </div>
</div>

<style>
  .wp { position: relative; flex: none; display: flex; flex-direction: column; min-width: 280px; min-height: 0; border-left: 1px solid var(--border); background: var(--bg-elev); }
  .top { flex: none; border-bottom: 1px solid var(--border); }
  .body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .live { flex: none; min-height: 0; }
  .files { flex: 1; min-height: 0; }
</style>
