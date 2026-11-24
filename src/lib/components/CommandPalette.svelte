<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { Preset } from "$lib/sessions.svelte";

  let {
    activeId,
    preset,
    onclose,
  }: { activeId: string | null; preset: Preset | null; onclose: () => void } = $props();

  let query = $state("");
  let commands = $state<string[]>([]);
  let sel = $state(0);
  let inputEl: HTMLInputElement;

  let filtered = $derived(
    commands.filter((c) => c.toLowerCase().includes(query.toLowerCase()))
  );

  $effect(() => {
    // 활성 세션 종류에 맞는 명령 목록 로드
    invoke<any>("settings_get")
      .then((s) => {
        const map = s?.commands ?? {};
        commands = (preset && map[preset]) || [];
      })
      .catch(() => (commands = []));
  });

  $effect(() => {
    inputEl?.focus();
  });

  async function send(cmd: string) {
    if (activeId) {
      await invoke("session_write", { id: activeId, data: cmd + "\r" }).catch(() => {});
    }
    onclose();
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(sel + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[sel] ?? query.trim();
      if (cmd) send(cmd);
    }
  }
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <div class="palette" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="명령 팔레트">
    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={onkey}
      oninput={() => (sel = 0)}
      placeholder={preset ? `${preset} 명령 검색 · Enter로 전송` : "명령 입력"}
    />
    <ul>
      {#each filtered as c, i (c)}
        <li class:sel={i === sel}>
          <button onmouseenter={() => (sel = i)} onclick={() => send(c)}>{c}</button>
        </li>
      {/each}
      {#if filtered.length === 0 && query.trim()}
        <li class="sel">
          <button onclick={() => send(query.trim())}>"{query.trim()}" 전송</button>
        </li>
      {/if}
    </ul>
    <div class="hint">↑↓ 이동 · Enter 전송 · Esc 닫기</div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 50;
  }
  .palette {
    width: 520px;
    max-width: 92vw;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  input {
    width: 100%;
    padding: 14px 16px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 15px;
    outline: none;
    border-bottom: 1px solid var(--border);
  }
  ul { list-style: none; margin: 0; padding: 6px; max-height: 320px; overflow-y: auto; }
  li button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    font-family: var(--mono);
    cursor: pointer;
  }
  li.sel button,
  li button:hover {
    background: var(--accent);
    color: #fff;
  }
  .hint {
    padding: 8px 14px;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--border);
  }
</style>
