<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 지원을 끝낸 기능의 옛 탭: 제목과 안내 한 줄만 보여 준다
  let { title, note }: { title: string; note: string } = $props();
</script>

<div class="retired">
  <div class="t">{title}</div>
  <div class="n">{note}</div>
</div>

<style>
  .retired { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--muted); padding: 24px; text-align: center; }
  .t { font-size: 15px; font-weight: 600; color: var(--fg-dim); }
  .n { font-size: 13px; line-height: 1.6; }
</style>
