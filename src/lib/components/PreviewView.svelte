<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 웹 미리보기 탭: 이 PC의 개발 서버(localhost)를 허브 안에서 본다. 포트 자동 찾기 · 서버 실행 · 화면 크기 전환.
  import { onMount, onDestroy, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { addSession } from "$lib/sessions.svelte";
  import { isLocalUrl, normalizeUrl, WIDTHS, type Width } from "$lib/preview";
  import Icon from "./Icon.svelte";

  let { id, cwd = "", url = "", onurl }: { id: string; cwd?: string; url?: string; onurl?: (u: string) => void } = $props();

  const dir = untrack(() => cwd);
  let current = $state(untrack(() => url));
  let typed = $state(untrack(() => url));
  let reloadKey = $state(0);
  let width = $state<Width>("full");
  let probe = $state<{ open: number[]; script: string | null; guess: number | null } | null>(null);
  let waiting = $state(false);
  let err = $state("");
  let timer: ReturnType<typeof setInterval> | undefined;

  function go(u: string) {
    const n = normalizeUrl(u);
    err = "";
    if (!isLocalUrl(n)) {
      err = "이 PC의 주소(localhost · 127.0.0.1)만 열 수 있어요. 다른 사이트는 '브라우저로 열기'를 쓰세요.";
      return;
    }
    current = n;
    typed = n;
    onurl?.(n);
  }

  async function detect() {
    probe = await invoke<{ open: number[]; script: string | null; guess: number | null }>("preview_probe", { cwd: dir }).catch(() => null);
    return probe;
  }

  onMount(async () => {
    const p = await detect();
    if (!current && p) {
      const port = p.guess && p.open.includes(p.guess) ? p.guess : p.open[0];
      if (port) go(`http://localhost:${port}`);
    }
  });
  onDestroy(() => clearInterval(timer));

  /** npm run dev 등을 터미널 탭에서 실행하고, 포트가 열리면 자동으로 띄운다 */
  function startServer() {
    if (!probe?.script) return;
    addSession({ title: `서버 · ${dir.split(/[\\/]/).pop()}`, preset: "powershell", program: "powershell.exe", args: ["-NoExit", "-Command", `npm run ${probe.script}`], cwd: dir });
    waiting = true;
    let n = 0;
    clearInterval(timer);
    timer = setInterval(async () => {
      n++;
      const p = await detect();
      const port = p?.guess && p.open.includes(p.guess) ? p.guess : p?.open[0];
      if (port || n > 90) {
        clearInterval(timer);
        waiting = false;
        if (port) go(`http://localhost:${port}`);
      }
    }, 2000);
  }

  const openOutside = () => current && invoke("open_path", { path: current }).catch(() => {});
</script>

<div class="pv">
  <div class="bar">
    <button class="ib" title="새로고침" aria-label="새로고침" disabled={!current} onclick={() => reloadKey++}><Icon name="refresh" size={14} /></button>
    <input bind:value={typed} onkeydown={(e) => e.key === "Enter" && go(typed)} placeholder="http://localhost:5173" spellcheck="false" />
    <div class="seg">
      {#each Object.entries(WIDTHS) as [k, w] (k)}
        <button class:on={width === k} onclick={() => (width = k as Width)}>{w.label}</button>
      {/each}
    </div>
    <button class="ib" title="기본 브라우저로 열기" aria-label="브라우저로 열기" disabled={!current} onclick={openOutside}><Icon name="external" size={14} /></button>
  </div>
  {#if err}<div class="err">{err}</div>{/if}

  {#if current}
    <div class="stage">
      {#key reloadKey}
        <iframe title="웹 미리보기" src={current} style:width={WIDTHS[width].px ? `${WIDTHS[width].px}px` : "100%"} class:framed={!!WIDTHS[width].px}></iframe>
      {/key}
    </div>
  {:else}
    <div class="empty">
      {#if waiting}
        <p>서버가 뜨기를 기다리는 중… (터미널 탭에서 진행을 볼 수 있어요)</p>
      {:else}
        <p>이 폴더에서 떠 있는 개발 서버를 못 찾았어요.</p>
        {#if probe?.script}
          <button class="go" onclick={startServer}><code>npm run {probe.script}</code> 실행</button>
        {/if}
        {#if probe?.open.length}
          <p class="dim">다른 포트가 열려 있어요: {#each probe.open as p (p)}<button class="link" onclick={() => go(`http://localhost:${p}`)}>:{p}</button>{/each}</p>
        {/if}
        <p class="dim">주소를 직접 넣어도 돼요. 화면을 에이전트에게 보여주려면 Win+Shift+S로 캡처한 뒤 Claude·Codex 입력창에 Ctrl+V.</p>
        <button class="link" onclick={detect}>다시 찾기</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pv { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: var(--bg); }
  .bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  .bar input { flex: 1; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font-family: var(--mono); font-size: 12px; }
  .bar input:focus { outline: none; border-color: var(--accent); }
  .ib { display: grid; place-items: center; width: 28px; height: 28px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
  .ib:hover:not(:disabled) { color: var(--fg); background: var(--surface-2); }
  .ib:disabled { opacity: .4; }
  .seg { display: flex; padding: 2px; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .seg button { padding: 3px 9px; border: none; border-radius: calc(var(--radius-sm) - 2px); background: transparent; color: var(--muted); font-size: 11.5px; cursor: pointer; }
  .seg button.on { background: var(--surface-2); color: var(--fg); }
  .err { margin: 8px 10px 0; padding: 6px 9px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); font-size: 11.5px; }
  .stage { flex: 1; min-height: 0; display: flex; justify-content: center; overflow: auto; background: var(--bg-elev); }
  iframe { height: 100%; border: none; background: #fff; }
  iframe.framed { margin: 12px 0; height: calc(100% - 24px); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-sm); }
  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; font-size: 13px; }
  .empty p { margin: 0; max-width: 520px; line-height: 1.6; }
  .dim { color: var(--muted); font-size: 11.5px; }
  .go { height: 30px; padding: 0 14px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent); color: var(--accent-fg); font-weight: 600; cursor: pointer; }
  .link { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 11.5px; padding: 0 3px; }
  code { font-family: var(--mono); }
</style>
