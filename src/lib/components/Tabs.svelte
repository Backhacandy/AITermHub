<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { tabs, active, closeTab, type TabInfo } from "$lib/sessions.svelte";
  import { working } from "$lib/stats.svelte";
  import Icon from "./Icon.svelte";

  /** 팀 탭은 일하는 중이거나 합치지 않은 브랜치 작업이 있으면 한 번 묻는다(닫아도 '최근 닫은 팀'에서 다시 열 수 있음) */
  async function tryClose(t: TabInfo) {
    if (t.kind !== "pair" || !t.team?.length) return closeTab(t.id);
    const busy = !!working[t.id];
    const team = t.team.find((m) => m.lead)?.chat;
    const unmerged: string[] = [];
    // 일하는 중이면 확인 저장(커밋)을 하지 않도록 브랜치는 보지 않는다
    if (!busy && team && t.cwd) {
      for (const m of t.team.filter((x) => !x.lead && x.wt)) {
        const st = await invoke<string>("team_diffstat", { repo: t.cwd, team, member: m.id }).catch(() => "");
        if (st.trim()) unmerged.push(m.name);
      }
    }
    if (busy || unmerged.length) {
      const msg = `${busy ? "일하는 중인 에이전트가 있어요. 닫으면 지금 하던 일이 멈춰요.\n" : ""}${unmerged.length ? `아직 합치지 않은 작업이 있어요: ${unmerged.join(", ")} (브랜치에 남아 있어요).\n` : ""}닫아도 ＋ 메뉴의 '최근 닫은 팀'에서 그대로 다시 열 수 있어요. 닫을까요?`;
      const ok = await ask(msg, { title: "팀 탭 닫기", kind: "warning" }).catch(() => true);
      if (!ok) return;
    }
    closeTab(t.id);
  }

  /** 예전에 저장된 탭 제목의 이모지는 떼고 보여준다 */
  const strip = (t: string) => t.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "").trim() || t;
  /** 폴더가 있는 세션인데 제목에 폴더가 없으면(예전 탭) "이름 · 폴더"로 */
  function clean(t: TabInfo | string): string {
    if (typeof t === "string") return strip(t);
    const base = strip(t.title);
    const dir = t.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return dir && t.kind !== "term" && t.kind !== "company" && !base.includes(" · ") ? `${base} · ${dir}` : base;
  }
  // 탭이 많아 넘치면: 활성 탭이 늘 보이게 스크롤하고, 세로 휠로 옆으로 넘긴다
  let bar: HTMLDivElement | undefined = $state();
  $effect(() => {
    const id = active.id;
    tabs.length;
    requestAnimationFrame(() => bar?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id ?? "")}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });
  function onWheel(e: WheelEvent) {
    if (!bar || bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    bar.scrollLeft += e.deltaY;
    e.preventDefault();
  }

  function iconOf(t: TabInfo): string | null {
    if (t.kind === "pair") return "pair";
    if (t.kind === "compare") return "swap";
    if (t.kind === "preview") return "globe";
    if (t.kind === "company") return "company";
    if (t.kind === "agent") return "agent";
    if (t.preset === "powershell") return "terminal";
    if (t.preset === "cli") return "agent";
    return null;
  }
</script>

<div class="tabs" role="tablist" bind:this={bar} onwheel={onWheel}>
  {#each tabs as t (t.id)}
    {@const ic = iconOf(t)}
    <div class="tab" class:active={active.id === t.id} role="tab" aria-selected={active.id === t.id} title={clean(t)} data-id={t.id}>
      <button class="hit" onclick={() => (active.id = t.id)}>
        {#if ic}<span class="ic" data-kind={t.kind}><Icon name={ic} size={14} /></span>{:else}<span class="dot" data-preset={t.preset}></span>{/if}
        <span class="name">{clean(t)}</span>
      </button>
      <button class="x" title="닫기" aria-label="{clean(t)} 닫기" onclick={() => void tryClose(t)}><Icon name="close" size={12} stroke={2} /></button>
    </div>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    align-self: stretch;
    align-items: stretch;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    border-right: 1px solid var(--border-soft);
    color: var(--muted);
    flex: 0 1 auto;
    min-width: 110px;
    max-width: 240px;
  }
  .tab:hover { color: var(--fg); background: var(--surface); }
  .tab.active { color: var(--fg); background: var(--bg); }
  .tab.active::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--accent); }
  .hit {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    min-width: 0;
    padding: 0 6px 0 12px;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ic { display: grid; place-items: center; color: var(--muted); }
  .tab.active .ic { color: var(--fg-dim); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot[data-preset="claude"] { background: var(--preset-claude); }
  .dot[data-preset="codex"] { background: var(--preset-codex); }
  .x {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-right: 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
  }
  .tab:hover .x, .tab.active .x, .x:focus-visible { opacity: 1; }
  .x:hover { background: var(--surface-2); color: var(--fg); }
</style>
