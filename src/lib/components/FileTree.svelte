<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import TreeNode from "./TreeNode.svelte";

  interface Entry { name: string; dir: boolean; path: string }

  let { cwd }: { cwd?: string } = $props();

  let roots = $state<Entry[]>([]);
  let err = $state("");
  let preview = $state<{ name: string; text: string } | null>(null);

  async function load() {
    err = "";
    roots = [];
    if (!cwd) return;
    try {
      roots = await invoke<Entry[]>("fs_read_dir", { path: cwd });
    } catch (e) {
      err = String(e);
    }
  }

  // cwd 바뀌면 다시 로드
  $effect(() => {
    cwd;
    load();
  });

  async function openPreview(path: string, name: string) {
    try {
      const text = await invoke<string>("fs_read_text", { path, maxBytes: 100000 });
      preview = { name, text };
    } catch (e) {
      preview = { name, text: `[열 수 없음: ${e}]` };
    }
  }
</script>

<div class="ft">
  <div class="head">
    <span class="t">탐색기</span>
    {#if cwd}<button class="refresh" onclick={load} title="새로고침">⟳</button>{/if}
  </div>
  {#if !cwd}
    <div class="empty">폴더가 지정된 세션이 아니에요.<br />새 세션에서 폴더를 선택하면 여기 보여요.</div>
  {:else}
    <div class="path" title={cwd}>{cwd}</div>
    {#if err}
      <div class="empty err">{err}</div>
    {:else}
      <div class="tree">
        {#each roots as r (r.path)}
          <TreeNode name={r.name} path={r.path} dir={r.dir} onpreview={openPreview} />
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if preview}
  <div class="pv-overlay" onclick={() => (preview = null)} role="presentation">
    <div class="pv" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="파일 미리보기">
      <header><span>{preview.name}</span><button onclick={() => (preview = null)}>×</button></header>
      <pre>{preview.text}</pre>
    </div>
  </div>
{/if}

<style>
  .ft { display: flex; flex-direction: column; height: 100%; }
  .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px 6px; }
  .t { font-size: 12px; font-weight: 700; letter-spacing: 0.02em; color: var(--muted); text-transform: uppercase; }
  .refresh { border: none; background: transparent; color: var(--muted); font-size: 14px; cursor: pointer; }
  .refresh:hover { color: var(--fg); }
  .path {
    padding: 2px 12px 8px;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .tree { flex: 1; overflow: auto; padding: 0 6px 10px; }
  .empty { padding: 24px 16px; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .empty.err { color: var(--danger); }
  .pv-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
  .pv { width: 70vw; max-width: 900px; height: 76vh; display: flex; flex-direction: column; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
  .pv header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13px; }
  .pv header button { border: none; background: transparent; color: var(--muted); font-size: 18px; cursor: pointer; }
  .pv pre { flex: 1; margin: 0; padding: 14px 16px; overflow: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.5; color: var(--fg-dim); white-space: pre-wrap; word-break: break-word; }
</style>
