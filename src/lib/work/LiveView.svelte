<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 오른쪽 위 라이브 코드 뷰: 지금 작업 중인(또는 고른) 파일/명령을 줄 번호와 변경 강조로.
  import { tick, untrack } from "svelte";
  import { lineDiff } from "./diff";
  import { fmtSize } from "./fileList";
  import type { Work } from "./work.svelte";
  import type { FileEntry } from "./types";
  import { composeReview } from "./comments";

  let { work, onrequest }: { work: Work; onrequest?: (text: string) => void } = $props();


  const MAX_LINES = 5000;
  const MAX_CHARS = 300_000;

  let f = $derived(work.shown);
  let text = $derived(f ? f.content.slice(0, MAX_CHARS) : "");
  let all = $derived(text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));
  let lines = $derived(all.slice(0, MAX_LINES));
  let truncated = $derived(!!f && (f.content.length > MAX_CHARS || all.length > MAX_LINES));
  let changed = $derived.by(() =>
    f && f.kind === "edit" && !f.binary && typeof f.prev === "string" ? new Set(lineDiff(f.prev, text).changed) : new Set<number>()
  );

  let box: HTMLDivElement;
  let userScrolled = $state(false);
  let programmatic = false;
  let lastKey = "";

  function stateText(x: FileEntry): string {
    if (x.writing) return "작성 중…";
    if (x.binary) return "바이너리";
    if (x.status === "pending") return "승인 대기";
    if (x.status === "rejected") return "거부됨";
    if (x.status === "error") return x.note ?? "오류";
    if (x.kind === "run") return x.status === "running" ? "실행 중…" : "명령 출력";
    if (x.kind === "read") return "읽음";
    if (x.note) return x.note;
    return x.prev === "" ? "새 파일" : "수정됨";
  }

  // 내용이 바뀌면 변경된 줄로 따라간다(사용자가 직접 스크롤했으면 멈춤)
  $effect(() => {
    const key = f?.key ?? "";
    void text;
    void changed;
    const writing = f?.writing ?? false;
    untrack(() => {
      if (key !== lastKey) {
        lastKey = key;
        userScrolled = false;
      }
      if (userScrolled || !box) return;
      tick().then(() => {
        if (!box) return;
        programmatic = true;
        const marks = box.querySelectorAll<HTMLElement>(".ln.chg");
        const target = writing ? marks[marks.length - 1] : marks[0];
        if (target) target.scrollIntoView({ block: "center" });
        else box.scrollTop = writing ? box.scrollHeight : 0;
        requestAnimationFrame(() => (programmatic = false));
      });
    });
  });

  // 리뷰 코멘트: 줄 번호를 누르면 그 줄에 메모 → 모아서 "이대로 고쳐" 지시로
  let canComment = $derived(!!onrequest && !!f && !!f.path && f.kind !== "run" && !f.binary && !f.writing);
  let editing = $state<{ line: number; text: string } | null>(null);
  let cseq = 0;
  let mine = $derived(f ? work.comments.filter((c) => c.file === f.label) : []);
  function startComment(i: number) {
    if (!canComment) return;
    userScrolled = true; // 쓰는 동안 화면이 움직이지 않게
    editing = { line: i + 1, text: "" };
  }
  function saveComment() {
    if (!editing || !f || !editing.text.trim()) {
      editing = null;
      return;
    }
    work.comments.push({ id: ++cseq, file: f.label, line: editing.line, code: lines[editing.line - 1] ?? "", text: editing.text.trim() });
    editing = null;
  }
  function removeComment(id: number) {
    const i = work.comments.findIndex((c) => c.id === id);
    if (i >= 0) work.comments.splice(i, 1);
  }
  function sendComments() {
    const t = composeReview(work.comments);
    if (!t) return;
    onrequest?.(t);
    work.comments.splice(0);
  }
  function onCommentKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      saveComment();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      editing = null;
    }
  }
  const focus = (el: HTMLElement) => el.focus();

  function onScroll() {
    if (!programmatic) userScrolled = true;
  }
</script>

<div class="lv">
  <div class="hd">
    {#if f}
      <span class="badge" class:live={work.ui.follow}>{work.ui.follow ? "실시간" : "고정"}</span>
      <span class="path" title={f.path ?? f.label}>{f.label}</span>
      {#if f.encoding && f.encoding !== "utf-8" && !f.binary}<span class="enc" title="파일 인코딩">{f.encoding.toUpperCase()}</span>{/if}
      <span class="state" class:w={f.writing}>{stateText(f)}</span>
    {:else}
      <span class="badge live">실시간</span>
      <span class="path dim">작업이 시작되면 여기에 실시간으로 보여요</span>
    {/if}
    {#if !work.ui.follow}<button class="back" onclick={() => work.resumeLive()}>실시간으로 돌아가기</button>{/if}
  </div>
  <div class="code" bind:this={box} onscroll={onScroll}>
    {#each lines as ln, i (i)}
      <div class="ln" class:chg={changed.has(i)}>
        {#if canComment}
          <button class="no cm" title="이 줄에 코멘트" onclick={() => startComment(i)}>{i + 1}</button>
        {:else}
          <span class="no">{i + 1}</span>
        {/if}
        <span class="tx">{ln}{#if f?.writing && i === lines.length - 1}<span class="caret"></span>{/if}</span>
      </div>
      {#each mine.filter((c) => c.line === i + 1) as c (c.id)}
        <div class="cmt"><span>{c.text}</span><button title="코멘트 지우기" onclick={() => removeComment(c.id)}>×</button></div>
      {/each}
      {#if editing && editing.line === i + 1}
        <div class="cmt edit">
          <input use:focus bind:value={editing.text} onkeydown={onCommentKey} onblur={saveComment} placeholder="이 줄에 대한 코멘트 (Enter 저장 · Esc 취소)" />
        </div>
      {/if}
    {/each}
    {#if f?.binary}
      <div class="blank">바이너리 파일(이미지·압축 등)이라 내용을 표시하지 않아요{f.size ? ` · ${fmtSize(f.size)}` : ""}</div>
    {:else if f && lines.length === 0}<div class="blank">{f.writing ? "작성 중…" : "(빈 내용)"}</div>{/if}
    {#if truncated}<div class="trunc">앞부분만 표시(최대 5,000줄)</div>{/if}
  </div>
  {#if userScrolled && f}<button class="follow" class:up={work.comments.length > 0} onclick={() => (userScrolled = false)}>따라가기</button>{/if}
  {#if work.comments.length && onrequest}
    <div class="cbar">
      <span>코멘트 {work.comments.length}개</span>
      <button class="ok" onclick={sendComments} title="코멘트를 모아 '이대로 고쳐' 지시로 입력창에 넣어요">지시에 넣기</button>
      <button onclick={() => work.comments.splice(0)}>모두 지우기</button>
    </div>
  {/if}
</div>

<style>
  .lv { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--term-bg); }
  .hd { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 12px; border-bottom: 1px solid var(--border); background: var(--bg-elev); font-size: 12px; }
  .badge { flex: none; display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; font-weight: 600; }
  .badge.live { color: var(--fg-dim); }
  .badge.live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); color: var(--fg); }
  .path.dim { font-family: inherit; color: var(--muted); }
  .state { flex: none; font-size: 11px; color: var(--muted); }
  .enc { flex: none; padding: 0 5px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--warn); font-size: 10px; }
  .state.w { color: var(--accent); }
  .back { flex: none; padding: 2px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg-dim); font-size: 11px; cursor: pointer; }
  .back:hover { color: var(--fg); background: var(--surface-2); }
  .code { flex: 1; overflow: auto; padding: 6px 0; font-family: var(--mono); font-size: 12px; line-height: 1.6; }
  .ln { display: flex; white-space: pre; }
  .ln.chg { background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: var(--muted); opacity: 0.55; user-select: none; }
  .ln.chg .no { color: var(--ok); opacity: 1; }
  .tx { padding-right: 16px; color: var(--term-fg); }
  .caret { display: inline-block; width: 7px; height: 1.1em; vertical-align: text-bottom; background: var(--accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  button.no { padding: 0 12px 0 0; border: none; background: transparent; font: inherit; line-height: inherit; cursor: pointer; }
  button.no:hover { color: var(--accent); opacity: 1; }
  .cmt { display: flex; align-items: center; gap: 6px; margin: 2px 12px 4px 46px; padding: 4px 8px; border-left: 2px solid var(--accent); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; background: color-mix(in srgb, var(--accent) 10%, var(--surface)); font-family: var(--font); font-size: 12px; white-space: normal; color: var(--fg); }
  .cmt span { flex: 1; }
  .cmt button { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; }
  .cmt button:hover { color: var(--danger); }
  .cmt.edit input { flex: 1; height: 24px; padding: 0 6px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; outline: none; }
  .cbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--border); background: var(--bg-elev); font-size: 11.5px; }
  .cbar span { flex: 1; color: var(--fg-dim); }
  .cbar button { height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg-dim); font-size: 11.5px; cursor: pointer; }
  .cbar button.ok { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  .follow.up { bottom: 48px; }
  .blank, .trunc { padding: 14px 16px; color: var(--muted); font-size: 12px; }
  .follow { position: absolute; right: 14px; bottom: 12px; padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); font-size: 11.5px; cursor: pointer; box-shadow: var(--shadow-sm); }
</style>
