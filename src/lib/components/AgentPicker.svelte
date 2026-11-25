<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 다른 CLI 에이전트 고르기: 설치돼 있으면 폴더를 골라 터미널 탭으로 열고, 아니면 설치 명령을 실행한다.
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { ALL_AIS, agentById, launchArgs, type AiEntry } from "$lib/agents/registry";
  import { addCliAgent, addInstallTab, addClaude, addCodex } from "$lib/sessions.svelte";
  import { settings } from "$lib/settings.svelte";
  import Icon from "./Icon.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let found = $state<Record<string, string | null>>({});
  let checking = $state(true);

  async function check() {
    checking = true;
    const r = await invoke<(string | null)[]>("which_cli", { names: ALL_AIS.map((a) => a.cmd) }).catch(() => []);
    found = Object.fromEntries(ALL_AIS.map((a, i) => [a.id, r[i] ?? null]));
    checking = false;
  }
  onMount(check);

  async function launch(a: AiEntry) {
    const dir = await openDialog({ directory: true, title: `${a.name}로 작업할 폴더` });
    if (typeof dir !== "string") return;
    const full = !!settings.fullAccess;
    if (a.id === "claude") addClaude(dir, undefined, full ? "bypassPermissions" : "default");
    else if (a.id === "codex") addCodex(dir, undefined, full ? "danger-full-access" : "workspace-write", full ? "never" : "on-request");
    else {
      const c = agentById(a.id);
      if (c) addCliAgent(c, launchArgs(c, full), dir);
    }
    onclose();
  }
  function install(a: AiEntry) {
    addInstallTab(a.name, a.install);
    onclose();
  }
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="AI 추가">
    <header>
      <span>AI 추가</span>
      <button class="x" aria-label="새로 확인" title="설치 여부 다시 확인" onclick={check}><Icon name="refresh" size={14} /></button>
      <button class="x" aria-label="닫기" onclick={onclose}><Icon name="close" size={14} /></button>
    </header>
    <p class="intro">
      설치된 AI를 폴더에서 열어요. Claude Code·Codex는 진행 로그·실시간 diff·계정 자동 전환·압축 관리가 되는 전용 탭으로, 다른 AI는 터미널 탭으로 열려요.
      {settings.fullAccess ? "전체 권한이 켜져 있어 지원하는 에이전트는 확인 없이 실행해요." : ""}
    </p>
    <div class="list">
      {#each ALL_AIS as a (a.id)}
        {@const p = found[a.id]}
        <div class="row">
          <div class="info">
            <div class="nm">{a.name} <span class="cmd">{a.cmd}</span></div>
            <div class="sub">{p ? "설치됨" : checking ? "확인 중…" : "설치 안 됨"}{a.note ? ` · ${a.note}` : ""}</div>
            {#if !p && !checking}<div class="inst" title="설치 명령">{a.install}</div>{/if}
          </div>
          {#if p}
            <button class="go" onclick={() => launch(a)}>폴더에서 열기</button>
          {:else}
            <button onclick={() => install(a)} disabled={checking} title="PowerShell 탭에서 설치 명령을 실행해요">설치</button>
          {/if}
        </div>
      {/each}
    </div>
    <p class="foot">설치가 끝나면 ↻로 다시 확인하세요. 처음 실행할 때 각 에이전트의 로그인 안내가 터미널에 나와요.</p>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; justify-content: center; align-items: center; z-index: 50; }
  .modal { width: 520px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
  header { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13.5px; }
  header span { flex: 1; }
  .x { display: grid; place-items: center; width: 26px; height: 26px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
  .x:hover { background: var(--surface-2); color: var(--fg); }
  .intro, .foot { margin: 10px 16px 0; font-size: 11.5px; color: var(--muted); line-height: 1.55; }
  .foot { margin: 8px 16px 12px; }
  .list { overflow: auto; padding: 8px 12px 0; }
  .row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
  .info { flex: 1; min-width: 0; }
  .nm { font-size: 12.5px; font-weight: 600; }
  .cmd { margin-left: 6px; font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--muted); }
  .sub { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
  .inst { margin-top: 3px; font-family: var(--mono); font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row button { flex: none; height: 28px; padding: 0 11px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg); font-size: 12px; cursor: pointer; }
  .row button:hover:not(:disabled) { background: var(--surface-2); }
  .row button.go { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  .row button:disabled { opacity: .5; cursor: default; }
</style>
