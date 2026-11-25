<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { sizeUsable, dimsUsable } from "$lib/termSize";
  import { SearchAddon } from "@xterm/addon-search";
  import "@xterm/xterm/css/xterm.css";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { settings } from "$lib/settings.svelte";
  import { markOutput } from "$lib/stats.svelte";
  import { withoutContinue } from "$lib/sessions.svelte";

  let {
    id = "main",
    program = "powershell.exe",
    args = [] as string[],
    cwd = undefined as string | undefined,
    active = true,
    suspended = false,
    /** 추가 환경변수(계정 로그인 탭: CLAUDE_CONFIG_DIR / CODEX_HOME) */
    env = undefined as [string, string][] | undefined,
  } = $props();

  let container: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let search: SearchAddon;
  let ro: ResizeObserver;
  let unlistenOut: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;

  let searchOpen = $state(false);
  let searchQuery = $state("");
  let exited = $state(false);

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function themeColors() {
    return {
      background: cssVar("--term-bg", "#15151b"),
      foreground: cssVar("--term-fg", "#e6e6ee"),
      cursor: cssVar("--accent", "#e08a5a"),
    };
  }

  onMount(async () => {
    term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", "D2Coding", Consolas, monospace',
      fontSize: settings.fontSize || 15,
      lineHeight: 1.35,
      letterSpacing: 0.2,
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 8000,
      theme: themeColors(),
    });
    fit = new FitAddon();
    search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(container);
    fit.fit();
    // 숨겨진 채 만들어진 탭(복원 등)은 아주 작게 맞춰질 수 있다 — 그 크기로 CLI를 시작하지 않는다(보일 때 다시 맞춘다)
    if (!dimsUsable(term.cols, term.rows)) term.resize(100, 30);

    const decoder = new TextDecoder();
    // 탭 전용 이벤트(pty-output-<id>)만 구독 — 다른 탭 출력까지 모든 탭이 받던 낭비 제거
    unlistenOut = await listen<{ data: string }>(`pty-output-${id}`, (e) => {
      markOutput(id);
      term.write(decoder.decode(b64ToBytes(e.payload.data), { stream: true }));
    });
    unlistenExit = await listen<{ id: string }>("pty-exit", (e) => {
      if (e.payload.id === id) {
        exited = true;
        term.write("\r\n\x1b[90m[프로세스 종료됨]\x1b[0m\r\n");
      }
    });

    term.onData((d) => {
      invoke("session_write", { id, data: d }).catch(() => {});
    });

    // Ctrl+F 검색 토글 / Ctrl+K 명령 팔레트
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
        searchOpen = true;
        return false;
      }
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        window.dispatchEvent(new CustomEvent("open-palette"));
        return false;
      }
      return true;
    });

    // 복원한 탭은 "이어서"(claude -c / codex resume --last)로 뜬다 — 이 폴더에 대화가 없으면 CLI가 바로 끝나므로 새 대화로
    let runArgs = args;
    const cli = args.includes("claude") && (args.includes("-c") || args.includes("--continue")) ? "claude"
      : args.includes("codex") && args.includes("resume") && args.includes("--last") ? "codex" : null;
    if (cli && cwd) {
      const list = await invoke<unknown[]>(cli === "claude" ? "claude_sessions" : "codex_sessions", { cwd, limit: 1 }).catch(() => null);
      if (Array.isArray(list) && list.length === 0) runArgs = withoutContinue(cli, args);
    }
    try {
      await invoke("session_create", { id, program, args: runArgs, cwd, cols: term.cols, rows: term.rows, env: env ?? null });
    } catch (err) {
      term.write(`\r\n\x1b[31m[세션 시작 실패: ${err}]\x1b[0m\r\n`);
      exited = true;
    }

    ro = new ResizeObserver(() => syncSize());
    ro.observe(container);
  });

  // 활성화되면 재맞춤 + 포커스
  $effect(() => {
    if (active && term && fit) {
      requestAnimationFrame(() => {
        try {
          syncSize();
          term.focus();
        } catch {}
      });
    }
  });

  // 테마 변경 반영
  $effect(() => {
    settings.theme;
    if (term) term.options.theme = themeColors();
  });

  // 글자 크기 설정 변경 반영
  $effect(() => {
    const fs = settings.fontSize || 14;
    if (term && term.options.fontSize !== fs) {
      term.options.fontSize = fs;
      try {
        syncSize();
      } catch {}
    }
  });

  /**
   * 화면 크기에 맞추고 CLI(PTY)에도 알린다. 탭이 숨겨졌거나(display:none) 분할 배치가 바뀌는 중이라
   * 너무 작으면 건너뛴다 — 아주 좁은 크기를 받은 CLI가 좁게 다시 그린 채 잠들면, 깰 때까지 화면이 깨져 보였다.
   */
  function syncSize() {
    if (!term || !fit || !container) return;
    if (!sizeUsable(container.clientWidth, container.clientHeight)) return;
    fit.fit();
    if (!dimsUsable(term.cols, term.rows)) return;
    invoke("session_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
  }

  function doSearch(dir: 1 | -1) {
    if (!searchQuery) return;
    if (dir === 1) search.findNext(searchQuery);
    else search.findPrevious(searchQuery);
  }
  function searchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      searchOpen = false;
      term.focus();
    } else if (e.key === "Enter") {
      doSearch(e.shiftKey ? -1 : 1);
    }
  }

  onDestroy(() => {
    ro?.disconnect();
    unlistenOut?.();
    unlistenExit?.();
    invoke("session_kill", { id }).catch(() => {});
    term?.dispose();
  });
</script>

<div class="wrap">
  {#if searchOpen}
    <div class="search">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        bind:value={searchQuery}
        onkeydown={searchKey}
        oninput={() => doSearch(1)}
        placeholder="검색 (Enter/Shift+Enter)"
      />
      <button onclick={() => doSearch(-1)} title="이전">↑</button>
      <button onclick={() => doSearch(1)} title="다음">↓</button>
      <button onclick={() => (searchOpen = false)} title="닫기">×</button>
    </div>
  {/if}

  <div class="term" bind:this={container}></div>

  {#if suspended && !exited}
    <div class="sleep-overlay">
      <div class="badge">수면 중 · 입력하면 깨어나요</div>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; width: 100%; height: 100%; }
  .term { width: 100%; height: 100%; padding: 16px 20px; background: var(--term-bg); }
  .search {
    position: absolute;
    top: 6px;
    right: 14px;
    z-index: 10;
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 5px 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .search input {
    width: 180px;
    padding: 4px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--fg);
    font-size: 12px;
    outline: none;
  }
  .search button {
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 5px;
    background: var(--surface-2);
    color: var(--fg);
    cursor: pointer;
  }
  .search button:hover { background: var(--border); }
  .sleep-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12px;
    background: rgba(14, 14, 18, 0.35);
    pointer-events: none;
  }
  .badge {
    padding: 6px 14px;
    background: #2a3550;
    color: #9fbcff;
    border: 1px solid #3a4a70;
    border-radius: 20px;
    font-size: 12px;
  }
</style>
