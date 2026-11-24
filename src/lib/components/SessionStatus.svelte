<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { tabs, active, setRole, ROLE_LABELS, type Role } from "$lib/sessions.svelte";
  import { stats, isBusy, background, fmtMB } from "$lib/stats.svelte";
  import { tabState, teamMain } from "$lib/tabState";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { moveProject } from "$lib/moveProject";
  import { notify } from "$lib/notify";

  // 프로젝트 경로 바꾸기: 폴더를 옮긴 뒤 새 위치를 고르면 에이전트 기억(대화 기록)도 새 경로로 옮긴다
  let moving = $state<string | null>(null);
  async function changePath(tb: (typeof tabs)[number], busy: boolean) {
    if (busy) return notify({ kind: "done", title: "경로 바꾸기", body: "일하는 중이에요 — 끝난 뒤(또는 멈춘 뒤) 바꿔 주세요", tabId: tb.id });
    const to = await openDialog({ directory: true, defaultPath: tb.cwd, title: "옮긴 프로젝트 폴더 고르기" }).catch(() => null);
    if (typeof to !== "string" || !to) return;
    moving = tb.id;
    try {
      const r = await moveProject(tb, to);
      const miss = r.missing.length ? ` · 작업 폴더 ${r.missing.length}개가 새 경로에 없어 그 에이전트는 프로젝트 폴더에서 이어 가요` : "";
      notify({ kind: "done", title: "경로를 바꿨어요", body: `${to} · 대화 기록 ${r.copied}개 옮김${miss}${r.repaired ? "" : " · 작업 폴더 git 연결을 고치지 못했어요"}`, tabId: tb.id });
    } catch (e) {
      notify({ kind: "done", title: "경로를 바꾸지 못했어요", body: String(e), tabId: tb.id });
    } finally {
      moving = null;
    }
  }

  function baseName(p?: string): string {
    if (!p) return "기본 폴더";
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }
  const LABEL = { busy: "작업중", bg: "백그라운드", sleep: "수면", idle: "유휴" } as const;
  function stateOf(id: string, kind: string, claudeIds: string[]): { label: string; cls: string } {
    const main = kind === "pair" ? teamMain(claudeIds.map((c) => stats[`${id}~${c}`]).filter(Boolean)) : stats[id];
    const st = tabState(kind, isBusy(id), main, !!background[id]);
    return { label: LABEL[st], cls: st };
  }
  const roles: Role[] = [null, "plan", "build", "review"];
  function cycleRole(id: string, cur: Role) {
    const i = roles.indexOf(cur ?? null);
    setRole(id, roles[(i + 1) % roles.length]);
  }
  // 팀 탭은 에이전트들(Claude·Codex 프로세스)의 메모리를 합쳐 보여준다
  function pairStat(id: string) {
    const all = Object.values(stats).filter((s) => s.id.startsWith(`${id}~`));
    if (!all.length) return undefined;
    return { ...all[0], id, rss: all.reduce((n, s) => n + s.rss, 0) };
  }
  /** 팀 탭의 Claude 에이전트 id(옛 협업 탭이면 "claude") */
  const claudeIds = (tb: { team?: { id: string; cli: string }[] }) => tb.team?.filter((m) => m.cli === "claude").map((m) => m.id) ?? ["claude"];
</script>

<div class="ss">
  <div class="head"><span class="t">세션 상태</span></div>
  <div class="list">
    {#each tabs as tb (tb.id)}
      {@const st = stateOf(tb.id, tb.kind, claudeIds(tb))}
      {@const s = tb.kind === "pair" ? pairStat(tb.id) : stats[tb.id]}
      <div class="card" class:active={active.id === tb.id}>
        <button class="main" onclick={() => (active.id = tb.id)}>
          <div class="row1">
            <span class="dot {st.cls === 'busy' ? 'pulse' : ''}" data-preset={tb.preset}></span>
            <span class="name">{tb.title.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "").trim()}</span>
            {#if tb.model}<span class="model">{tb.model}</span>{/if}
            <span class="state {st.cls}" title={st.cls === "bg" ? "답은 끝났어요. 에이전트가 띄운 백그라운드 작업(대기 반복·빌드 등)이 아직 돌고 있어요 — 끝나면 스스로 이어 답할 수 있어요" : undefined}>{st.label}</span>
          </div>
          <div class="row2">
            <span class="folder" title={tb.cwd}>{baseName(tb.cwd)}</span>
            <span class="rss">
              {#if s}{fmtMB(s.rss)}{:else if st.cls === "sleep"}0 MB{:else}—{/if}
            </span>
          </div>
        </button>
        {#if tb.cwd && tb.kind !== "company" && tb.kind !== "agent"}
          <button class="role" disabled={moving === tb.id} onclick={() => changePath(tb, st.cls === "busy")} title="프로젝트 경로 바꾸기 — 폴더를 옮겼으면 새 위치를 골라요. 에이전트 기억(대화 기록)도 새 경로로 옮겨요(원래 기록은 그대로 둬요)">{moving === tb.id ? "옮기는 중" : "경로"}</button>
        {/if}
        <button
          class="role"
          class:set={!!tb.role}
          onclick={() => cycleRole(tb.id, tb.role ?? null)}
          title="역할 전환"
        >
          {tb.role ? ROLE_LABELS[tb.role] : "역할"}
        </button>
      </div>
    {/each}
    {#if tabs.length === 0}
      <div class="empty">세션 없음</div>
    {/if}
  </div>
</div>

<style>
  .ss { display: flex; flex-direction: column; height: 100%; }
  .head { display: flex; align-items: center; height: 38px; padding: 0 14px; border-bottom: 1px solid var(--border); }
  .t { font-size: 12px; font-weight: 600; color: var(--fg-dim); }
  .list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  .card { display: flex; align-items: stretch; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .card.active { border-color: color-mix(in srgb, var(--accent) 65%, var(--border)); box-shadow: inset 2px 0 0 var(--accent); }
  .main { flex: 1; min-width: 0; border: none; background: transparent; color: var(--fg); text-align: left; cursor: pointer; padding: 6px 7px; border-radius: var(--radius-sm); }
  .main:hover { background: var(--surface-2); }
  .row1 { display: flex; align-items: center; gap: 7px; }
  .name { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .model { font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
  .state { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--muted); white-space: nowrap; }
  .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .state.busy { color: var(--fg); } .state.busy::before { background: var(--ok); }
  .state.bg { color: var(--fg-dim); } .state.bg::before { background: var(--accent); opacity: .6; }
  .state.sleep { color: var(--sleep); } .state.sleep::before { background: var(--sleep); }
  .row2 { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
  .folder { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rss { font-size: 11px; color: var(--fg-dim); font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .role { flex: none; width: 42px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; }
  .role:hover { background: var(--surface-2); color: var(--fg); }
  .role.set { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 12px; }
</style>
