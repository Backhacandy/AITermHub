<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { tabs, active, ROLE_LABELS } from "$lib/sessions.svelte";

  let text = $state("");
  let multi = $state(false);
  let selected = $state<Record<string, boolean>>({});
  let ta: HTMLTextAreaElement;

  $effect(() => {
    for (const t of tabs) if (!(t.id in selected)) selected[t.id] = true;
  });

  let activeTab = $derived(tabs.find((t) => t.id === active.id) ?? null);
  let targets = $derived(
    multi
      ? tabs.filter((t) => selected[t.id]).map((t) => t.id)
      : active.id
        ? [active.id]
        : []
  );
  let placeholder = $derived(
    activeTab?.preset === "claude"
      ? "Claude에게 메시지…"
      : activeTab?.preset === "codex"
        ? "Codex에게 메시지…"
        : "명령 입력…"
  );

  function autogrow() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  async function send() {
    if (!text.trim() || targets.length === 0) return;
    const payload = text;
    for (const id of targets) {
      await invoke("session_write", { id, data: payload + "\r" }).catch(() => {});
    }
    text = "";
    requestAnimationFrame(autogrow);
  }
  function stop() {
    // Esc 전송(모델 작업 중단)
    for (const id of targets) invoke("session_write", { id, data: "\x1b" }).catch(() => {});
  }
  function onkey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="composer">
  {#if multi}
    <div class="targets">
      <span class="tl">받는 세션</span>
      {#each tabs as t (t.id)}
        <button class="chip" class:on={selected[t.id]} onclick={() => (selected[t.id] = !selected[t.id])}>
          <span class="dot" data-preset={t.preset}></span>{t.title}{#if t.role}<span class="r">·{ROLE_LABELS[t.role]}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="box">
    <button
      class="mode"
      class:on={multi}
      title={multi ? "여러 세션에 전송 중" : "여러 세션에 전송"}
      onclick={() => (multi = !multi)}>여러 탭</button
    >
    <textarea
      bind:this={ta}
      bind:value={text}
      oninput={autogrow}
      onkeydown={onkey}
      rows="1"
      {placeholder}
    ></textarea>
    <button class="stop" title="중단 · Esc" onclick={stop}>중단</button>
    <button class="send" onclick={send} disabled={!text.trim() || targets.length === 0} title="보내기 · Enter">
      ↑
    </button>
  </div>
  <div class="hint">
    {multi ? `${targets.length}개 세션` : (activeTab?.title ?? "세션 없음")} · Enter 전송 · Shift+Enter 줄바꿈
  </div>
</div>

<style>
  .composer {
    padding: 10px 16px 14px;
    background: transparent;
  }
  .targets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .tl { font-size: 11.5px; color: var(--muted); font-weight: 600; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border: 1px solid var(--border); border-radius: 14px;
    background: var(--surface); color: var(--muted); font-size: 11.5px; cursor: pointer;
  }
  .chip.on { color: var(--fg); border-color: var(--accent); background: var(--accent-soft); }
  .chip .r { color: var(--accent); }

  .box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 8px 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 18px;
    box-shadow: var(--shadow-sm);
    transition: border-color var(--ease), box-shadow var(--ease);
  }
  .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  textarea {
    flex: 1;
    resize: none;
    max-height: 200px;
    min-height: 26px;
    padding: 6px 2px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 15px;
    line-height: 1.5;
    font-family: inherit;
    outline: none;
  }
  .mode, .stop, .send {
    flex: none;
    border: none;
    cursor: pointer;
    border-radius: 12px;
  }
  .mode {
    width: 34px; height: 34px;
    background: transparent;
    color: var(--muted);
    font-size: 15px;
  }
  .mode:hover { background: var(--surface-2); }
  .mode.on { background: var(--accent-soft); color: var(--accent); }
  .stop {
    height: 34px; padding: 0 12px;
    background: var(--surface-2); color: var(--fg-dim); font-size: 12.5px;
  }
  .stop:hover { background: var(--border); }
  .send {
    width: 36px; height: 36px;
    background: var(--accent); color: #fff; font-size: 17px; font-weight: 700;
  }
  .send:disabled { opacity: 0.4; cursor: default; }
  .hint { margin-top: 6px; padding-left: 14px; font-size: 11px; color: var(--muted); }
</style>
