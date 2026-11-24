<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 왼쪽 작업 로그: › 지시 / 본문 / ├ 도구 한 줄 요약. 스크롤 규칙은 Sticky.
  import { onMount, onDestroy, tick, untrack } from "svelte";
  import { Sticky } from "./stickyScroll";
  import Markdown from "./Markdown.svelte";
  import type { Work } from "./work.svelte";

  let { work, running = false, status = "", empty = "" }:
    { work: Work; running?: boolean; status?: string; empty?: string } = $props();

  let scroller: HTMLDivElement;
  let inner: HTMLDivElement;
  let sticky: Sticky | undefined;
  let unread = $state(0);
  let seen = 0;

  // 파일 수정 줄은 오른쪽 "만진 파일" 목록에서만 보여준다(로그는 대화·읽기·실행 위주).
  // 단, 승인이 필요한 수정(로컬 에이전트)은 버튼이 있어야 하므로 남긴다.
  let visible = $derived(work.log.filter((e) => !(e.kind === "tool" && e.verb === "edit" && e.status !== "pending")));

  const VERB: Record<string, string> = { read: "읽기", edit: "편집", run: "실행", other: "도구" };
  /** 안내 줄: 이모지·장식 대시는 떼고 담백하게 */
  const plain = (t: string) => t.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "").replace(/^\s*—\s*|\s*—\s*$/g, "").replace(/\s{2,}/g, " ").trim();

  onMount(() => {
    sticky = new Sticky(scroller, inner, (atBottom) => {
      if (atBottom) unread = 0;
    });
    seen = visible.length;
    sticky.toBottom();
  });
  onDestroy(() => sticky?.destroy());

  // 새 항목: 내가 보낸 메시지면 무조건 바닥으로, 아니면 위를 보고 있을 때만 "새 메시지" 수를 센다
  $effect(() => {
    const n = visible.length;
    untrack(() => {
      if (n <= seen) {
        seen = n;
        return;
      }
      const added = visible.slice(seen);
      seen = n;
      if (added.some((e) => e.kind === "user")) {
        unread = 0;
        tick().then(() => sticky?.toBottom());
      } else if (sticky && !sticky.atBottom) {
        unread += added.length;
      }
    });
  });

  function jump() {
    sticky?.toBottom();
    unread = 0;
  }
</script>

<div class="wl">
  <div class="scroll" bind:this={scroller}>
    <div class="inner" bind:this={inner}>
      {#if visible.length === 0 && empty}<div class="empty">{empty}</div>{/if}
      {#each visible as e, i (e.key)}
        {#if e.kind === "user"}
          <div class="user">{e.text}</div>
        {:else if e.kind === "ai"}
          <div class="ai"><Markdown text={e.text} /></div>
        {:else if e.kind === "tool"}
          <button class="tool {e.status}" disabled={!e.fileKey} onclick={() => e.fileKey && work.select(e.fileKey)}>
            <span class="vb" data-verb={e.verb ?? "other"}>{VERB[e.verb ?? "other"]}</span>
            <span class="tg">{e.text}</span>
            {#if e.meta}<span class="mt">{e.meta}</span>{/if}
            {#if e.status === "running"}<span class="spin">…</span>
            {:else if e.status === "pending"}<span class="pend">승인 대기</span>
            {:else if e.status === "error"}<span class="bad">실패</span>
            {:else if e.status === "rejected"}<span class="rej">거부됨</span>{/if}
          </button>
          {#if e.status === "pending" && e.approve}
            <div class="approve">
              <button class="no" onclick={() => e.approve?.(false)}>거부</button>
              <button class="ok" onclick={() => e.approve?.(true)}>승인하고 적용</button>
            </div>
          {/if}
        {:else if e.kind === "error"}
          <div class="err">{plain(e.text).replace(/^⚠\s*/, "")}</div>
        {:else}
          <div class="note">{plain(e.text)}</div>
        {/if}
      {/each}
      {#if running}
        <div class="working"><span class="dot"></span>작업 중{#if status}<span class="cur">{status}</span>{/if}</div>
      {/if}
    </div>
  </div>
  {#if unread > 0}<button class="jump" onclick={jump}>새 메시지 {unread}개 · 아래로</button>{/if}
</div>

<style>
  .wl { position: relative; flex: 1; min-height: 0; display: flex; }
  .scroll { flex: 1; overflow-y: auto; }
  .inner { max-width: 860px; margin: 0 auto; padding: 16px 22px 10px; display: flex; flex-direction: column; gap: 3px; font-size: 13.5px; line-height: 1.65; }
  .user {
    margin: 14px 0 6px;
    padding: 9px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font-weight: 500;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user:first-child { margin-top: 0; }
  .ai { padding: 2px 2px 6px; color: var(--fg); }
  .tool { display: flex; align-items: center; gap: 10px; width: 100%; padding: 2px 8px; border: none; border-radius: var(--radius-sm); background: none; color: var(--fg-dim); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
  .tool:hover:not(:disabled) { background: var(--surface); }
  .tool:disabled { cursor: default; }
  .vb { flex: none; min-width: 30px; color: var(--muted); font-size: 11.5px; }
  .vb[data-verb="run"] { color: var(--sleep); }
  .vb[data-verb="edit"] { color: var(--ok); }
  .tg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12px; color: var(--fg); }
  .tool.error .tg { color: var(--danger); }
  .tool.rejected .tg { color: var(--muted); text-decoration: line-through; }
  .mt { font-family: var(--mono); font-size: 11.5px; color: var(--ok); }
  .spin { color: var(--sleep); }
  .pend { font-size: 11px; color: var(--warn); }
  .bad { font-size: 11px; color: var(--danger); }
  .rej { font-size: 11px; color: var(--muted); }
  .approve { display: flex; gap: 6px; margin: 4px 0 8px 48px; }
  .approve button { padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg); font-size: 12px; cursor: pointer; }
  .approve .ok { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .err { margin: 2px 0; padding: 6px 10px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .note { display: flex; align-items: center; gap: 10px; padding: 6px 0; color: var(--muted); font-size: 11.5px; }
  .note::before, .note::after { content: ""; flex: 1; height: 1px; background: var(--border-soft); }
  .working { display: flex; align-items: center; gap: 8px; padding: 8px 2px 4px; color: var(--muted); font-size: 12px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
  .cur { font-family: var(--mono); color: var(--fg-dim); }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .empty { margin: 18vh auto 0; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.7; white-space: pre-line; }
  .jump { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); font-size: 12px; cursor: pointer; box-shadow: var(--shadow-sm); }
</style>
