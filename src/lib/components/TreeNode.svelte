<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import Self from "./TreeNode.svelte";
  import Icon from "./Icon.svelte";

  interface Entry { name: string; dir: boolean; path: string }

  let {
    name,
    path,
    dir,
    depth = 0,
    onpreview,
  }: {
    name: string;
    path: string;
    dir: boolean;
    depth?: number;
    onpreview: (path: string, name: string) => void;
  } = $props();

  let open = $state(false);
  let children = $state<Entry[] | null>(null);
  let loading = $state(false);


  async function toggle() {
    if (!dir) {
      onpreview(path, name);
      return;
    }
    open = !open;
    if (open && children === null) {
      loading = true;
      children = await invoke<Entry[]>("fs_read_dir", { path }).catch(() => []);
      loading = false;
    }
  }
</script>

<button class="node" style="padding-left:{depth * 12 + 8}px" onclick={toggle} title={name}>
  <span class="ic" class:d={dir}>{#if dir}<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />{:else}<Icon name="file" size={13} />{/if}</span>
  <span class="nm">{name}</span>
  {#if loading}<span class="load">…</span>{/if}
</button>

{#if dir && open && children}
  {#each children as c (c.path)}
    <Self name={c.name} path={c.path} dir={c.dir} depth={depth + 1} {onpreview} />
  {/each}
{/if}

<style>
  .node {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 8px;
    border: none;
    background: transparent;
    color: var(--fg-dim);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
    white-space: nowrap;
    overflow: hidden;
  }
  .node:hover { background: var(--surface-2); color: var(--fg); }
  .ic { flex: none; display: grid; place-items: center; width: 14px; color: var(--muted); }
  .ic.d { color: var(--fg-dim); }
  .nm { overflow: hidden; text-overflow: ellipsis; }
  .load { color: var(--muted); }
</style>
