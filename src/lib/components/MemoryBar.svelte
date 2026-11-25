<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { tabs } from "$lib/sessions.svelte";
  import { stats, fmtMB } from "$lib/stats.svelte";
  import Icon from "./Icon.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let totalRss = $derived(
    Object.values(stats).reduce((a, s) => a + s.rss, 0)
  );

  async function trim(id: string) {
    await invoke("session_trim", { id }).catch(() => {});
  }
  async function toggleSleep(id: string, suspended: boolean) {
    await invoke(suspended ? "session_wake" : "session_sleep", { id }).catch(() => {});
  }
  async function togglePin(id: string, pinned: boolean) {
    await invoke("session_pin", { id, pinned: !pinned }).catch(() => {});
  }
</script>

<aside class="panel">
  <header>
    <span class="h">세션 메모리</span>
    <button class="close" onclick={onclose} title="닫기">×</button>
  </header>
  <div class="total">합계 <b>{fmtMB(totalRss)}</b></div>

  <div class="list">
    {#each tabs as t (t.id)}
      {@const s = stats[t.id]}
      <div class="row" class:slept={s?.suspended}>
        <div class="info">
          <span class="dot" data-preset={t.preset}></span>
          <span class="name">{t.title}</span>
          {#if s?.pinned}<span class="tag pin">고정</span>{/if}
          {#if s?.suspended}<span class="tag sleep">수면</span>{/if}
        </div>
        <div class="rss">{s ? fmtMB(s.rss) : "—"}</div>
        <div class="btns">
          <button onclick={() => trim(t.id)} title="메모리 정리">정리</button>
          <button
            class:wake={s?.suspended}
            onclick={() => toggleSleep(t.id, !!s?.suspended)}
            title={s?.suspended ? "깨우기" : "재우기"}
          >
            {s?.suspended ? "깨우기" : "재우기"}
          </button>
          <button
            class="pin"
            class:on={s?.pinned}
            onclick={() => togglePin(t.id, !!s?.pinned)}
            title="항상 깨어 있기"><Icon name="pin" size={13} /></button
          >
        </div>
      </div>
    {/each}
    {#if tabs.length === 0}
      <div class="empty">세션 없음</div>
    {/if}
  </div>
</aside>

<style>
  .panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .h { font-size: 13px; font-weight: 600; }
  .close {
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 18px;
    cursor: pointer;
  }
  .total {
    padding: 8px 12px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .total b { color: var(--fg); }
  .list { flex: 1; overflow-y: auto; padding: 8px; }
  .row {
    padding: 9px;
    border-radius: 8px;
    margin-bottom: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .row.slept { opacity: 0.6; }
  .info { display: flex; align-items: center; gap: 7px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot[data-preset="claude"] { background: #d9772b; }
  .dot[data-preset="codex"] { background: #10a37f; }
  .dot[data-preset="powershell"] { background: #5b8bf0; }
  .name { font-size: 12.5px; font-weight: 600; }
  .tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
  }
  .tag.pin { background: #4a4a20; color: #e8d16a; }
  .tag.sleep { background: #2a3550; color: #8fb0ff; }
  .rss { margin: 6px 0; font-size: 12px; color: var(--muted); }
  .btns { display: flex; gap: 5px; }
  .btns button {
    flex: 1;
    padding: 5px 0;
    font-size: 11.5px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--fg);
    cursor: pointer;
  }
  .btns button:hover { background: var(--border); }
  .btns button.wake { background: #2a3550; color: #8fb0ff; border-color: #3a4a70; }
  .btns button.pin { flex: 0 0 34px; display: grid; place-items: center; padding: 0; }
  .btns button.pin.on { background: #4a4a20; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 12px; }
</style>
