<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 영역 경계 드래그 손잡이. 드래그 중 포인터 위치를 그대로 넘기고, 크기 계산은 부모가 한다.
  // 더블클릭하면 기본 크기로(onreset).
  let {
    dir = "x",
    ondrag,
    onreset,
    style = "",
  }: { dir?: "x" | "y"; ondrag: (e: PointerEvent) => void; onreset?: () => void; style?: string } = $props();

  let dragging = $state(false);

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    document.body.classList.add("resizing", dir === "x" ? "resizing-x" : "resizing-y");
  }
  function move(e: PointerEvent) {
    if (dragging) ondrag(e);
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing", "resizing-x", "resizing-y");
  }
</script>

<div
  class="sp {dir}"
  class:dragging
  {style}
  role="separator"
  aria-orientation={dir === "x" ? "vertical" : "horizontal"}
  title="드래그로 크기 조절 · 더블클릭으로 기본값"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={() => onreset?.()}
></div>

<style>
  .sp { position: absolute; z-index: 20; touch-action: none; }
  .sp.x { top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; }
  .sp.y { left: 0; right: 0; height: 8px; margin-top: -4px; cursor: row-resize; }
  .sp::after { content: ""; position: absolute; background: transparent; transition: background var(--ease); }
  .sp.x::after { top: 0; bottom: 0; left: 3px; width: 2px; }
  .sp.y::after { left: 0; right: 0; top: 3px; height: 2px; }
  .sp:hover::after, .sp.dragging::after { background: var(--accent); }
  /* 드래그 중엔 텍스트 선택·다른 요소의 커서를 막는다 */
  :global(body.resizing) { user-select: none; }
  :global(body.resizing-x *) { cursor: col-resize !important; }
  :global(body.resizing-y *) { cursor: row-resize !important; }
</style>
