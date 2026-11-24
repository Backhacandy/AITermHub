<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 비교 탭: 같은 지시를 Claude와 Codex가 각자 작업 공간에서 → 결과(diff)를 나란히 보고 하나를 골라 합친다.
  import { onMount, onDestroy, untrack } from "svelte";
  import WorkLog from "$lib/work/WorkLog.svelte";
  import PromptBox from "$lib/work/PromptBox.svelte";
  import { createCompare, diffStats, NAME, SIDES, DEFAULT_MODEL, type Side } from "$lib/compare/compare.svelte";
  import { LANE_MODELS } from "$lib/pair/models";
  import { notify, titleFor } from "$lib/notify";

  let { id, cwd = "" }: { id: string; cwd?: string } = $props();

  const dir = untrack(() => cwd);
  const tabId = untrack(() => id);
  const cmp = createCompare(dir, tabId);
  const st = cmp.st;

  let input = $state("");
  const models = $state<Record<Side, string>>({ ...DEFAULT_MODEL });
  /** 레인별 보기: 진행 로그 / 바뀐 내용 */
  const view = $state<Record<Side, "log" | "diff">>({ claude: "log", codex: "log" });
  let busy = $derived(st.phase === "preparing" || st.phase === "running");
  const MAX_DIFF_LINES = 4000;

  onMount(() => void cmp.init());
  onDestroy(() => cmp.dispose());

  // 결과가 나오면 바뀐 내용 보기로 + 알림
  let lastPhase = "";
  $effect(() => {
    const p = st.phase;
    untrack(() => {
      if (p === "review" && lastPhase === "running") {
        for (const s of SIDES) view[s] = st.lanes[s].diff ? "diff" : "log";
        notify({ kind: "input", title: titleFor(tabId, "비교"), body: "두 결과가 나왔어요 — 하나를 골라 주세요", tabId });
      }
      lastPhase = p;
    });
  });

  function send() {
    const t = input.trim();
    if (!t || busy) return;
    input = "";
    void cmp.start(t, { ...models });
  }

  const secs = (a: number, b: number) => (a && b ? `${Math.max(1, Math.round((b - a) / 1000))}초` : "");
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const STATUS: Record<string, string> = { idle: "대기", running: "작업 중…", done: "완료", error: "실패" };
  const diffLines = (d: string) => d.split("\n").slice(0, MAX_DIFF_LINES);
  const cls = (l: string) =>
    l.startsWith("diff --git") ? "fh" : l.startsWith("@@") ? "hk" : l.startsWith("+") && !l.startsWith("+++") ? "ad" : l.startsWith("-") && !l.startsWith("---") ? "rm" : "";
</script>

<div class="cv">
  <div class="top">
    <div class="ttl">
      <b>비교</b>
      <span class="dim">같은 지시를 Claude와 Codex가 각자 작업 공간에서 수행하고, 더 나은 결과를 골라 합쳐요</span>
    </div>
    <div class="mods">
      {#each SIDES as s (s)}
        <label>
          {NAME[s]}
          <select bind:value={models[s]} disabled={busy}>
            {#each LANE_MODELS[s].filter((m) => m.id !== "auto") as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
          </select>
        </label>
      {/each}
    </div>
  </div>

  {#if st.dirty && st.phase !== "idle"}
    <div class="warn">커밋 안 된 변경은 비교에 들어가지 않아요. 같은 파일을 고쳤다면 합칠 때 충돌할 수 있어요.</div>
  {/if}
  {#if st.error}<div class="err">{st.error}</div>{/if}

  {#if st.phase === "idle"}
    <div class="empty">
      <p>아래에 지시를 쓰면 Claude와 Codex가 <b>동시에</b> 각자 작업해요.</p>
      <p class="dim">같은 지시를 Claude·Codex가 따로 작업하고, 결과를 나란히 보고 하나를 골라 합쳐요. 토큰은 두 배로 들어요.</p>
    </div>
  {:else}
    <div class="lanes">
      {#each SIDES as s (s)}
        {@const L = st.lanes[s]}
        {@const ds = diffStats(L.diff)}
        <section class="lane {s}">
          <header>
            <span class="nm">{NAME[s]}</span>
            <span class="md">{LANE_MODELS[s].find((m) => m.id === L.model)?.label ?? L.model}</span>
            <span class="stt {L.status}">{STATUS[L.status]}</span>
            <span class="sp"></span>
            {#if L.endedAt}<span class="dim">{secs(L.startedAt, L.endedAt)} · 토큰 {k(L.tokens.input + L.tokens.cached + L.tokens.output)}</span>{/if}
          </header>
          <div class="seg">
            <button class:on={view[s] === "log"} onclick={() => (view[s] = "log")}>진행</button>
            <button class:on={view[s] === "diff"} onclick={() => (view[s] = "diff")} disabled={!L.diff}>
              바뀐 내용{#if L.diff} · 파일 {ds.files} <span class="ad">+{ds.added}</span> <span class="rm">−{ds.removed}</span>{/if}
            </button>
          </div>
          {#if L.error}<div class="lerr">{L.error}</div>{/if}
          <div class="body">
            {#if view[s] === "log"}
              <WorkLog work={L.work} running={L.status === "running"} status={L.work.ui.status} empty="시작하는 중…" />
            {:else}
              {#if L.answer}<div class="ans">{L.answer}</div>{/if}
              <pre class="diff">{#each diffLines(L.diff) as l, i (i)}<span class={cls(l)}>{l}
</span>{/each}</pre>
            {/if}
          </div>
          {#if st.phase === "review"}
            <footer>
              <button class="pick" disabled={!L.diff} onclick={() => cmp.accept(s)}>{NAME[s]} 결과로 합치기</button>
            </footer>
          {/if}
        </section>
      {/each}
    </div>
    <div class="bar">
      {#if st.phase === "preparing"}<span>작업 공간 만드는 중…</span>
      {:else if st.phase === "running"}<span>두 에이전트가 작업 중이에요</span><button onclick={() => cmp.stop()}>모두 중단</button>
      {:else if st.phase === "review"}<span>마음에 드는 쪽을 골라 합치세요</span><button onclick={() => cmp.discard()}>둘 다 버리기</button>
      {:else if st.phase === "merged"}<span>합쳤어요 · 커밋 <code>{st.merged}</code></span><button onclick={() => cmp.discard()}>새 비교</button>
      {:else if st.phase === "error"}<button onclick={() => cmp.discard()}>처음으로</button>{/if}
    </div>
  {/if}

  <PromptBox bind:value={input} cwd={dir} disabled={busy || !dir} running={busy} placeholder={st.phase === "review" ? "새 지시를 보내면 지금 결과는 버려져요" : "두 에이전트에게 같은 지시…"} onsend={send} oncancel={() => cmp.stop()} />
</div>

<style>
  .cv { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: var(--bg); }
  .top { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .ttl { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
  .dim { color: var(--muted); font-size: 11.5px; }
  .mods { display: flex; gap: 10px; font-size: 12px; color: var(--fg-dim); }
  .mods select { margin-left: 4px; height: 24px; padding: 0 6px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); font-size: 11.5px; }
  .warn, .err { margin: 8px 14px 0; padding: 6px 10px; border-radius: var(--radius-sm); font-size: 11.5px; }
  .warn { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }
  .err { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
  .empty { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 6px; padding: 24px; text-align: center; font-size: 13px; }
  .empty p { margin: 0; max-width: 560px; line-height: 1.6; }
  .lanes { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 10px 14px 0; }
  .lane { display: flex; flex-direction: column; min-height: 0; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
  .lane.claude { box-shadow: inset 0 2px 0 var(--preset-claude); }
  .lane.codex { box-shadow: inset 0 2px 0 var(--preset-codex); }
  .lane header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border-soft); font-size: 12px; }
  .nm { font-weight: 600; }
  .md { color: var(--muted); font-size: 11px; }
  .stt { font-size: 11px; color: var(--fg-dim); }
  .stt.running { color: var(--accent); }
  .stt.done { color: var(--ok); }
  .stt.error { color: var(--danger); }
  .sp { flex: 1; }
  .seg { display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border-soft); }
  .seg button { padding: 3px 10px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); font-size: 11.5px; cursor: pointer; }
  .seg button.on { background: var(--surface-2); color: var(--fg); border-color: var(--border); }
  .seg button:disabled { opacity: .45; cursor: default; }
  .ad { color: var(--ok); }
  .rm { color: var(--danger); }
  .lerr { padding: 6px 10px; font-size: 11.5px; color: var(--danger); border-bottom: 1px solid var(--border-soft); }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  .ans { padding: 8px 10px; font-size: 12px; line-height: 1.55; white-space: pre-wrap; border-bottom: 1px solid var(--border-soft); color: var(--fg-dim); max-height: 30%; overflow: auto; flex: none; }
  .diff { margin: 0; padding: 6px 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; background: var(--term-bg); color: var(--term-fg); flex: 1; }
  .diff span { display: block; padding: 0 10px; white-space: pre; }
  .diff .fh { margin-top: 6px; padding-top: 3px; border-top: 1px solid var(--border); color: var(--fg); font-weight: 600; }
  .diff .hk { color: var(--accent); }
  .diff .ad { background: color-mix(in srgb, var(--ok) 13%, transparent); color: var(--term-fg); }
  .diff .rm { background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--term-fg); }
  .lane footer { padding: 8px 10px; border-top: 1px solid var(--border-soft); }
  .pick { width: 100%; height: 30px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent); color: var(--accent-fg); font-weight: 600; font-size: 12px; cursor: pointer; }
  .pick:disabled { background: transparent; border-color: var(--border); color: var(--muted); cursor: default; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; font-size: 12px; color: var(--fg-dim); }
  .bar span { flex: 1; }
  .bar button { height: 26px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg); font-size: 12px; cursor: pointer; }
  .bar button:hover { background: var(--surface-2); }
  code { font-family: var(--mono); }
  @media (max-width: 760px) { .lanes { grid-template-columns: 1fr; } }
</style>
