<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import { learnCodexModels } from "$lib/pair/models";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import Terminal from "$lib/components/Terminal.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { listenBusy, loadAccounts, startUsageWatch } from "$lib/accounts.svelte";
  import { startGrass, migrateGrassDirs, grassHistory, grassEmail } from "$lib/grass";
  import { startPortfolio } from "$lib/portfolioRun";
  import { startCliUpdate } from "$lib/cliUpdate";
  import { startStorage } from "$lib/work/storageRun.svelte";
  import { STORAGE_DEFAULTS } from "$lib/work/storagePolicy";
  import { register as registerStorage } from "$lib/work/storageRegistry";
  import { notify } from "$lib/notify";
  import { restoreRemotes } from "$lib/remote.svelte";
  import { startRemoteBus } from "$lib/remoteBus.svelte";
  import RetiredView from "$lib/components/RetiredView.svelte";
  import ClaudeView from "$lib/components/ClaudeView.svelte";
  import CodexView from "$lib/components/CodexView.svelte";
  import Tabs from "$lib/components/Tabs.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import NewSession from "$lib/components/NewSession.svelte";
  import ActivityRail from "$lib/components/ActivityRail.svelte";
  import type { View } from "$lib/types";
  import RightPanel from "$lib/components/RightPanel.svelte";
  import CompareView from "$lib/components/CompareView.svelte";
  import AgentPicker from "$lib/components/AgentPicker.svelte";
  import PreviewView from "$lib/components/PreviewView.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import { tabs, active, addTab, addCompare, addPreview, restoreTabs, closedTeams, reopenTeam, saveTabs, type Preset } from "$lib/sessions.svelte";
  import TeamView from "$lib/components/TeamView.svelte";
  import { stats, startStats, fmtMB, working } from "$lib/stats.svelte";
  import { loadSettings, saveSettings, settings } from "$lib/settings.svelte";
  import { teamEnabled } from "$lib/experimental";
  import { startUpdateWatch } from "$lib/updater.svelte";
  import { appUpdateDeps } from "$lib/updaterApp";
  import UpdateBanner from "$lib/components/UpdateBanner.svelte";
  import ThanksBanner from "$lib/components/ThanksBanner.svelte";
  import Onboarding from "$lib/components/Onboarding.svelte";
  let teamOn = $derived(teamEnabled(settings, tabs.filter((t) => t.kind === "pair").length));
  import Splitter from "$lib/components/Splitter.svelte";
  import { layout, setLayout, resetLayout } from "$lib/layout.svelte";

  let menuOpen = $state(false);
  let view = $state<View>(null);
  let paletteOpen = $state(false);
  let settingsOpen = $state(false);
  /** 설정을 다 읽은 뒤, 첫 실행이면 안내 */
  let onboardOpen = $state(false);
  let agentsOpen = $state(false);
  let closeAsk = $state(false);
  let newOpen = $state(false);
  let newPreset = $state<Preset>("claude");
  let gridMode = $state<1 | 2 | 4>(1);
  // 탭 구성이 바뀔 때마다 저장(복원이 끝난 뒤부터 — 빈 목록으로 덮어쓰지 않게)
  let tabsRestored = $state(false);
  $effect(() => {
    JSON.stringify(tabs);
    void active.id;
    if (tabsRestored) saveTabs();
  });

  // 테마를 문서 루트에 반영(모달 포함 전역 적용)
  $effect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme || "dark");
  });

  let activeTab = $derived(tabs.find((t) => t.id === active.id) ?? null);
  let totalRss = $derived(Object.values(stats).reduce((a, s) => a + s.rss, 0));
  let visibleIds = $derived(
    gridMode === 1
      ? active.id
        ? [active.id]
        : []
      : tabs.slice(0, gridMode).map((t) => t.id)
  );

  onMount(() => {
    // Codex가 받아 둔 모델 목록을 배운다 — 새 모델(GPT-6.2 등)이 나오면 목록·자동 추천·팀장 안내가 따라간다
    void invoke<{ slug: string; label: string }[]>("codex_models").then((l) => learnCodexModels(l ?? []), () => {});
    startStats();
    listenBusy(); // AI 회사 창의 작업 중 표시도 모아서 계정 순서 잠금에 반영
    // 일하는 동안 지금 쓰는 계정의 사용량을 주기적으로 확인(패널이 닫혀 있어도)
    void loadAccounts();
    startUsageWatch(() => Object.keys(working).length > 0);
    startUpdateWatch(appUpdateDeps);
    // 정해 둔 폴더의 작업을 몇 시간마다 커밋해 GitHub에 올려 잔디가 쌓이게
    // Claude Code·Codex CLI: 하루 한 번, 일하는 에이전트가 없을 때만 올린다(결과·시각만 저장)
    startCliUpdate(
      () => ({ on: settings.cliAutoUpdate, lastAt: settings.cliUpdateAt, busy: Object.keys(working).length > 0 }),
      async (r, at) => {
        settings.cliUpdateAt = at;
        settings.cliUpdateLog = r.text;
        const disk = await invoke<Record<string, unknown>>("settings_get").catch(() => null);
        if (disk) await invoke("settings_save", { value: { ...disk, cliUpdateAt: at, cliUpdateLog: r.text } }).catch(() => {});
        if (r.notable) notify({ kind: "done", title: "CLI 업데이트", body: r.text });
      },
    );
    // 자동 갱신 시각만 저장한다(화면에서 고르는 중인, 저장하지 않은 값까지 저장되지 않게)
    startPortfolio(async (at) => {
      settings.portfolioAt = at;
      const disk = await invoke<Record<string, unknown>>("settings_get").catch(() => null);
      if (disk) await invoke("settings_save", { value: { ...disk, portfolioAt: at } }).catch(() => {});
    });
    startGrass(() => ({ on: settings.grassOn !== false, dirs: settings.grassDirs ?? [], email: () => grassEmail(settings, () => void saveSettings()) }));
    // 저장공간: 에이전트 임시 파일·오래 쉰 팀원 폴더·버린 기록을 치우고, 디스크가 바닥나기 전에 알리고 팀원 일을 멈춘다
    // 열린 탭(화면에 안 그려진 것 포함)과 최근 닫은 팀의 폴더·대화 id는 늘 지킨다
    registerStorage("app", {
      repos: () => [...tabs.map((t) => t.cwd ?? ""), ...closedTeams().map((c) => c.tab.cwd ?? "")],
      skipWts: () => [],
      skipLanes: () => [],
      keepIds: () =>
        [...tabs, ...closedTeams().map((c) => c.tab)].flatMap((t) => [t.resume ?? "", t.resume2 ?? "", ...(t.team ?? []).map((m) => m.resume ?? "")]),
    });
    startStorage(() => ({
      auto: settings.storageAuto !== false,
      cleanHours: settings.wtCleanHours ?? STORAGE_DEFAULTS.cleanHours,
      dirtyHours: settings.wtDirtyHours ?? STORAGE_DEFAULTS.dirtyHours,
      warnGB: settings.diskWarnGB ?? STORAGE_DEFAULTS.warnGB,
      stopGB: settings.diskStopGB ?? STORAGE_DEFAULTS.stopGB,
      notify: (title, body) => notify({ kind: "error", title, body }),
    }));
    startRemoteBus(); // 폰(원격 세션)의 @상태·@pair·@co 요청 받기
    // 설정(권한 등)을 먼저 읽은 뒤 탭을 연다 — 복원된 탭이 저장된 권한 설정으로 시작하도록
    loadSettings().finally(() => {
      // 이미 쓰던 사람(마지막 폴더가 저장돼 있음)에게는 띄우지 않는다
      if (!settings.onboarded && !settings.lastCwd) onboardOpen = true;
      // 예전 버전은 잔디 폴더 목록을 코드에 두었다 → 설정 파일에 목록이 없을 때만, 지금까지 올린 폴더 기록으로 한 번 옮긴다
      // (설정을 다 읽은 뒤에 — 그 전에 저장하면 다른 설정이 기본값으로 덮인다)
      if (!settings.grassDirs) {
        const dirs = migrateGrassDirs(undefined, grassHistory());
        if (dirs.length) {
          settings.grassDirs = dirs;
          void saveSettings();
        }
      }
      // 지난번에 열려 있던 탭을 같은 설정으로 다시 열고(대화는 이어서), 없으면 기본 탭
      if (tabs.length === 0 && !restoreTabs()) addTab("powershell");
      tabsRestored = true;
      // 폰에서 열 수 있게 켜 두었던 폴더를 다시 연결
      void restoreRemotes();
    });
    window.addEventListener("open-palette", openPalette);
    let unlistenClose: (() => void) | undefined;
    listen("app-close-request", () => (closeAsk = true)).then((u) => (unlistenClose = u));
    return () => {
      window.removeEventListener("open-palette", openPalette);
      unlistenClose?.();
    };
  });

  // 분할 화면 경계 드래그(패딩 8px·간격 8px 제외한 영역 기준 비율)
  let gridEl: HTMLDivElement;
  function dragGridCol(e: PointerEvent) {
    const r = gridEl.getBoundingClientRect();
    setLayout("gridColPct", ((e.clientX - r.left - 12) / (r.width - 24)) * 100, 15, 85);
  }
  function dragGridRow(e: PointerEvent) {
    const r = gridEl.getBoundingClientRect();
    setLayout("gridRowPct", ((e.clientY - r.top - 12) / (r.height - 24)) * 100, 15, 85);
  }
  let gridStyle = $derived(
    gridMode === 1
      ? ""
      : `grid-template-columns:${layout.gridColPct}fr ${100 - layout.gridColPct}fr;` +
          (gridMode === 4 ? `grid-template-rows:${layout.gridRowPct}fr ${100 - layout.gridRowPct}fr;` : "")
  );

  function openPalette() {
    if (active.id) paletteOpen = true;
  }
  function openNew(preset: Preset) {
    newPreset = preset;
    newOpen = true;
    menuOpen = false;
  }
  async function openCompare() {
    menuOpen = false;
    const dir = await openDialog({ directory: true });
    if (typeof dir === "string") addCompare(dir);
  }
  async function openPreview() {
    menuOpen = false;
    const dir = await openDialog({ directory: true, title: "미리볼 웹 프로젝트 폴더" });
    if (typeof dir === "string") addPreview(dir);
  }
  function onGlobalKey(e: KeyboardEvent) {
    if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      openPalette();
    }
  }
  /** ＋ 메뉴를 열 때 최근 닫은 팀 목록을 읽는다 */
  let closed = $derived(menuOpen ? closedTeams() : []);
  function ago(at: number): string {
    const m = Math.round((Date.now() - at) / 60_000);
    if (m < 1) return "방금";
    if (m < 60) return `${m}분 전`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
  }

  async function quit() {
    await invoke("force_quit").catch(() => {});
  }
</script>

<svelte:window onclick={() => (menuOpen = false)} onkeydown={onGlobalKey} />

<div class="app">
  <ActivityRail
    {view}
    onview={(v) => (view = v)}
    onsettings={() => (settingsOpen = true)}
  />

  <main class="center">
    <UpdateBanner />
    <ThanksBanner />
    <header class="bar">
      <Tabs />
      <div class="newtab">
        <button class="icon" title="새 세션" aria-label="새 세션" onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}><Icon name="plus" size={15} /></button>
        {#if menuOpen}
          <div class="menu" role="menu">
            <div class="mh">세션</div>
            <button onclick={() => openNew("claude")}><span class="d claude"></span>새로 만들기<span class="hint">{teamOn ? "팀 · Claude · Codex" : "Claude · Codex"}</span></button>
            <button onclick={() => openNew("powershell")}><span class="mi"><Icon name="terminal" size={14} /></span>PowerShell</button>
            {#if teamOn && closed.length}
              <div class="sep"></div>
              <div class="mh">최근 닫은 팀</div>
              {#each closed.slice(0, 5) as c, i (c.at)}
                <button onclick={() => { menuOpen = false; reopenTeam(i); }}><span class="mi"><Icon name="pair" size={14} /></span>{c.tab.title}<span class="hint">{ago(c.at)}</span></button>
              {/each}
            {/if}
            {#if teamOn}
            <div class="sep"></div>
            <div class="mh">함께 일하기</div>
            <button onclick={openCompare}><span class="mi"><Icon name="swap" size={14} /></span>Claude vs Codex 비교<span class="hint">골라서 합치기</span></button>
            {/if}
            <div class="sep"></div>
            <button onclick={openPreview}><span class="mi"><Icon name="globe" size={14} /></span>웹 미리보기<span class="hint">개발 서버</span></button>
            <button onclick={() => { menuOpen = false; agentsOpen = true; }}><span class="mi"><Icon name="agent" size={14} /></span>AI 추가<span class="hint">Claude · Codex · Gemini 등</span></button>
          </div>
        {/if}
      </div>
      <div class="spacer"></div>
      <div class="grid-toggle" title="화면 분할">
        {#each [1, 2, 4] as m (m)}
          <button class:on={gridMode === m} aria-label="{m}분할" onclick={() => (gridMode = m as 1 | 2 | 4)}><Icon name={m === 1 ? "grid1" : m === 2 ? "grid2" : "grid4"} size={15} /></button>
        {/each}
      </div>
      <span class="total" title="전체 세션 메모리">{fmtMB(totalRss)}</span>
      <button class="icon" title="명령 팔레트 · Ctrl+K" aria-label="명령 팔레트" onclick={openPalette}><Icon name="command" size={14} /></button>
    </header>

    <section class="stage">
      <div class="grid g{gridMode}" bind:this={gridEl} style={gridStyle}>
        {#each tabs as t (t.id)}
          {@const vis = visibleIds.includes(t.id)}
          <div
            class="pane"
            class:show={vis}
            class:focused={active.id === t.id && gridMode > 1}
            onclickcapture={() => (active.id = t.id)}
            role="presentation"
          >
            <!-- 프로젝트 경로를 바꾸면 화면을 새로 띄워 새 경로에서 같은 대화로 이어 간다 -->
            {#key t.cwd}
            {#if t.kind === "company"}
              <RetiredView title="자동 진행" note="자동 진행은 팀으로 합쳐졌어요. 팀 탭에서 팀장에게 지시하세요. 이 탭은 닫아 주세요." />
            {:else if t.kind === "preview"}
              <PreviewView id={t.id} cwd={t.cwd} url={t.url} onurl={(u) => (t.url = u)} />
            {:else if t.kind === "compare"}
              <CompareView id={t.id} cwd={t.cwd} />
            {:else if t.kind === "pair"}
              <TeamView id={t.id} cwd={t.cwd} team={t.team} resume={t.resume} resume2={t.resume2} models={t.models} onteam={(m) => (t.team = m)} addOpen={t.addOpen} onaddshown={() => (t.addOpen = false)} kickoff={t.kickoff} onkickoff={() => (t.kickoff = undefined)} />
            {:else if t.kind === "agent"}
              <RetiredView title="로컬 에이전트" note="로컬 에이전트(Ollama)는 더 이상 지원하지 않아요. 이 탭은 닫아 주세요." />
            {:else if t.kind === "claude"}
              <ClaudeView id={t.id} cwd={t.cwd} model={t.model} effort={t.effort} permission={t.permission} cont={t.cont} bare={t.bare} resume={t.resume} onsession={(s) => (t.resume = s)} />
            {:else if t.kind === "codex"}
              <CodexView id={t.id} cwd={t.cwd} model={t.model} effort={t.effort} sandbox={t.sandbox} approval={t.approval} cont={t.cont} resume={t.resume} onthread={(th) => (t.resume = th)} />
            {:else}
              <Terminal
                id={t.id}
                program={t.program}
                args={t.args}
                cwd={t.cwd}
                env={t.env}
                active={active.id === t.id}
                suspended={stats[t.id]?.suspended ?? false}
              />
            {/if}
            {/key}
          </div>
        {/each}
        {#if gridMode > 1}
          <Splitter dir="x" ondrag={dragGridCol} onreset={() => resetLayout("gridColPct")} style="left:calc(12px + (100% - 24px) * {layout.gridColPct / 100})" />
          {#if gridMode === 4}
            <Splitter dir="y" ondrag={dragGridRow} onreset={() => resetLayout("gridRowPct")} style="top:calc(12px + (100% - 24px) * {layout.gridRowPct / 100})" />
          {/if}
        {/if}
        {#if tabs.length === 0}
          <div class="empty">세션이 없습니다. <b>+</b> 로 새 탭을 여세요.</div>
        {/if}
      </div>

      {#if activeTab?.kind === "term"}
        <Composer />
      {/if}
    </section>
  </main>

  {#if view}
    <RightPanel {view} cwd={activeTab?.cwd} onclose={() => (view = null)} />
  {/if}
</div>

{#if paletteOpen}
  <CommandPalette activeId={active.id} preset={activeTab?.preset ?? null} onclose={() => (paletteOpen = false)} />
{/if}
{#if agentsOpen}
  <AgentPicker onclose={() => (agentsOpen = false)} />
{/if}
{#if onboardOpen}
  <Onboarding ondone={() => { onboardOpen = false; settings.onboarded = true; void saveSettings(); }} />
{/if}
{#if settingsOpen}
  <Settings onclose={() => (settingsOpen = false)} />
{/if}
{#if newOpen}
  <NewSession initialPreset={newPreset} onclose={() => (newOpen = false)} />
{/if}
{#if closeAsk}
  <div class="overlay" role="presentation">
    <div class="dialog" role="dialog" aria-label="종료 확인">
      <p>실행 중인 세션 {tabs.length}개가 있습니다. 모두 종료하고 닫을까요?</p>
      <div class="actions">
        <button class="cancel" onclick={() => (closeAsk = false)}>취소</button>
        <button class="danger" onclick={quit}>모두 종료하고 닫기</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .app { position: fixed; inset: 0; display: flex; background: var(--bg); }
  .center { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 38px;
    padding: 0 8px 0 0;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    -webkit-user-select: none;
    user-select: none;
  }
  .newtab { position: relative; margin-left: 4px; }
  .icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 26px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .icon:hover { background: var(--surface-2); color: var(--fg); }
  .menu {
    position: absolute;
    top: 32px;
    left: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 236px;
    padding: 5px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .mh { padding: 6px 9px 4px; font-size: 11px; color: var(--muted); }
  .menu button {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 9px; border: none; border-radius: var(--radius-sm); white-space: nowrap;
    background: transparent; color: var(--fg); font-size: 12.5px; text-align: left; cursor: pointer;
  }
  .menu button:hover { background: var(--surface-2); }
  .menu .hint { margin-left: auto; padding-left: 14px; font-size: 11px; color: var(--muted); }
  .mi { display: grid; place-items: center; width: 14px; color: var(--muted); }
  .d { width: 8px; height: 8px; margin: 0 3px; border-radius: 50%; }
  .d.claude { background: var(--preset-claude); }
  .d.codex { background: var(--preset-codex); }
  .menu .sep { height: 1px; background: var(--border-soft); margin: 4px 2px; }
  .spacer { flex: 1; }
  .grid-toggle { display: flex; gap: 1px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .grid-toggle button {
    display: grid; place-items: center;
    width: 26px; height: 20px; border: none; border-radius: calc(var(--radius-sm) - 2px);
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .grid-toggle button:hover { color: var(--fg); }
  .grid-toggle button.on { background: var(--surface-2); color: var(--fg); }
  .total { padding: 0 4px; white-space: nowrap; font-size: 11.5px; color: var(--muted); font-family: var(--mono); font-variant-numeric: tabular-nums; }

  .stage { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .grid { position: relative; flex: 1; min-height: 0; display: grid; gap: 6px; padding: 6px; }
  .grid.g1 { grid-template-columns: 1fr; padding: 0; }
  .grid.g2 { grid-template-columns: 1fr 1fr; }
  .grid.g4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .pane {
    display: none;
    position: relative;
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--term-bg);
  }
  .grid.g1 .pane { border: none; border-radius: 0; }
  .pane.show { display: block; }
  .pane.focused { border-color: var(--accent); }
  .empty { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; }

  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 60; }
  .dialog { width: 360px; padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
  .dialog p { margin: 0 0 16px; font-size: 13px; line-height: 1.55; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button { padding: 7px 14px; border-radius: var(--radius-sm); font-size: 12.5px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--fg); }
  .danger { background: var(--danger); color: #fff; border-color: var(--danger); }
</style>
