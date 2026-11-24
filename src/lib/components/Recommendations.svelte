<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 💡 추천: 맨 위 찾기(전체 플러그인·설치된 스킬, 목록에 없으면 이름@마켓 설치·마켓 추가),
  // 이 프로젝트에 맞는데 아직 안 깔린 플러그인, 깔렸지만 꺼진 것, 쓰는 중인 것, 쓸 만한 스킬, 토큰 절감 팁. 목록·상태는 로컬 파일에서(토큰 0).
  import { invoke } from "@tauri-apps/api/core";
  import { addClaude, addSession } from "$lib/sessions.svelte";
  import { recommend, skillsFor, searchCatalog, searchSkills, directOf, fmtTokens, type Scan, type Reco, type State } from "$lib/recommend/match";

  let { cwd }: { cwd?: string } = $props();

  let scan = $state<Scan | null>(null);
  let loading = $state(false);
  let copied = $state("");
  let q = $state("");
  let showOn = $state(false);

  function kb(n: number): string {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
    if (n >= 1024) return Math.round(n / 1024) + "KB";
    return n + "B";
  }

  async function load() {
    if (!cwd) { scan = null; return; }
    loading = true;
    try {
      scan = await invoke<Scan>("recommend_scan", { cwd });
    } catch {
      scan = null;
    }
    loading = false;
  }

  // cwd가 바뀌면 다시 스캔
  $effect(() => { cwd; load(); });

  let r = $derived(scan ? recommend(scan) : { missing: [], off: [], on: [] });
  let skills = $derived(scan ? skillsFor(scan) : []);
  let searching = $derived(!!q.trim());
  let found = $derived(scan ? searchCatalog(scan, q).map((x): Reco => ({ ...x, why: "" })) : []);
  let foundSkills = $derived(scan ? searchSkills(scan, q) : []);
  let direct = $derived(directOf(q));

  /** 설치·켜기는 Claude CLI 명령을 터미널 탭에서(확인 질문이 있으면 거기서 답한다). 끝나면 ⟳로 다시 스캔 */
  function runCli(title: string, line: string) {
    addSession({ title, preset: "claude", program: "cmd.exe", args: ["/k", line], cwd: cwd || undefined, kind: "term", transient: true });
  }
  const install = (x: { id: string; name: string }) => runCli(`${x.name} 설치`, `claude plugin install ${x.id}`);
  const enable = (x: { id: string; name: string }) => runCli(`${x.name} 켜기`, `claude plugin enable ${x.id}`);
  const addMarket = (source: string) => runCli("마켓 추가", `claude plugin marketplace add "${source.replace(/"/g, "")}"`);
  function runDirect() {
    if (!direct) return;
    if (direct.kind === "plugin") install({ id: direct.id, name: direct.id.split("@")[0] });
    else addMarket(direct.source);
  }
  async function copy(x: { id: string }) {
    try { await navigator.clipboard.writeText(`/plugin install ${x.id}`); copied = x.id; setTimeout(() => (copied = ""), 1600); } catch {}
  }

  const cost = (n: number | null) => (n ? `켜 두면 매 세션 약 ${fmtTokens(n)} 토큰` : "");
  const stateLabel: Record<State, string> = { missing: "안 깔림", off: "꺼져 있음", on: "쓰는 중" };

  type Tip = { id: string; name: string; token: string; session?: boolean };
  let tips = $derived.by((): Tip[] => {
    if (!scan) return [];
    const t: Tip[] = [];
    if (scan.claude_md_bytes > 8 * 1024)
      // --bare는 구독 로그인을 안 써서(API 키 과금) 권하지 않고, CLAUDE.md 자체를 줄이도록 안내
      t.push({ id: "tip-claudemd", name: "CLAUDE.md 줄이기", token: `CLAUDE.md ${kb(scan.claude_md_bytes)}가 매 세션 컨텍스트에 올라감 — 자주 안 쓰는 내용은 별도 문서로 분리` });
    if (scan.transcript_bytes > 5 * 1024 * 1024)
      t.push({ id: "tip-fresh", name: '"이어서" 대신 새 세션', token: `과거 대화 ${kb(scan.transcript_bytes)} 재업로드 방지 — '새로'로 시작`, session: true });
    const heavy = r.on.filter((x) => (x.always_on ?? 0) >= 8000);
    if (heavy.length)
      t.push({ id: "tip-heavy", name: "무거운 플러그인 끄기", token: `${heavy.map((x) => `${x.name}(${fmtTokens(x.always_on)})`).join(", ")} — 이 프로젝트에서 안 쓰면 꺼 두면 매 세션 그만큼 줄어요` });
    return t;
  });
</script>

{#snippet card(x: Reco)}
  <div class="card" class:done={x.state === "on"}>
    <div class="crow">
      <span class="badge plugin">플러그인</span>
      <span class="name" title={x.id}>{x.name}</span>
      {#if x.market !== "claude-plugins-official"}<span class="mk">{x.market}</span>{/if}
      <span class="stt {x.state}">{stateLabel[x.state]}</span>
    </div>
    {#if x.why}<div class="why q">{x.why}</div>{/if}
    {#if x.description}<div class="why desc" title={x.description}>{x.description}</div>{/if}
    {#if x.skills.length}<div class="why sk">스킬 {x.skills.length}개: {x.skills.slice(0, 5).join(", ")}{x.skills.length > 5 ? " …" : ""}</div>{/if}
    {#if cost(x.always_on)}<div class="why tk">{cost(x.always_on)}</div>{/if}
    {#if x.state === "missing"}
      <div class="acts">
        <button class="apply" onclick={() => install(x)}>설치</button>
        <button class="apply sub" onclick={() => copy(x)} title="Claude 대화창에 붙여 넣을 명령">{copied === x.id ? "복사됨" : "명령 복사"}</button>
      </div>
    {:else if x.state === "off"}
      <div class="acts"><button class="apply" onclick={() => enable(x)}>켜기</button></div>
    {/if}
  </div>
{/snippet}

<div class="reco">
  <div class="head">
    <span class="t">추천 · 찾기</span>
    <button class="refresh" title="다시 스캔(설치·켜기 뒤에 눌러 주세요)" onclick={load} disabled={!cwd || loading}>⟳</button>
  </div>

  {#if !cwd}
    <div class="empty">프로젝트 폴더가 열린 세션에서<br />맞춤 추천이 떠요.</div>
  {:else if loading && !scan}
    <div class="empty">스캔 중…</div>
  {:else if scan}
    {#if scan.signals.length}
      <div class="sigs">
        {#each scan.signals as s (s)}<span class="sig">{s}</span>{/each}
      </div>
    {/if}

    <input class="search" bind:value={q} placeholder="플러그인·스킬 찾기 · 이름@마켓 · owner/repo" onkeydown={(e) => { if (e.key === "Enter") runDirect(); if (e.key === "Escape") q = ""; }} />
    <div class="list">
      {#if searching}
        {#if direct}
          <div class="card">
            {#if direct.kind === "plugin"}
              <div class="crow"><span class="badge plugin">플러그인</span><span class="name">{direct.id}</span></div>
              <div class="why desc">이 이름으로 바로 설치해요(그 마켓이 추가돼 있어야 해요).</div>
            {:else}
              <div class="crow"><span class="badge plugin">마켓</span><span class="name">{direct.source}</span></div>
              <div class="why desc">이 마켓(GitHub 저장소·URL·폴더)을 추가해요. 추가한 뒤 ⟳를 누르면 그 안의 플러그인이 찾기에 떠요.</div>
            {/if}
            <div class="acts"><button class="apply" onclick={runDirect}>{direct.kind === "plugin" ? "설치" : "마켓 추가"}</button></div>
          </div>
        {/if}
        {#if found.length}
          <div class="group">플러그인 {found.length}개</div>
          {#each found as x (x.id)}{@render card(x)}{/each}
        {/if}
        {#if foundSkills.length}
          <div class="group">설치된 스킬</div>
          {#each foundSkills as k (k.name)}
            <div class="card">
              <div class="crow"><span class="badge">스킬</span><span class="name">{k.name}</span>{#if k.plugin}<span class="mk">{k.plugin}</span>{/if}</div>
              {#if k.description}<div class="why desc" title={k.description}>{k.description}</div>{/if}
            </div>
          {/each}
        {/if}
        {#if !found.length && !foundSkills.length && !direct}
          <div class="hint">전체 {scan.catalog.length}개에서 못 찾았어요. 목록에 없는 건 "이름@마켓"으로 바로 설치하거나, 마켓의 GitHub 저장소(owner/repo)를 넣어 추가할 수 있어요.</div>
        {/if}
      {:else}
      {#if r.missing.length}
        <div class="group">설치하면 좋은 것</div>
        {#each r.missing as x (x.id)}{@render card(x)}{/each}
      {/if}

      {#if r.off.length}
        <div class="group">깔려 있지만 꺼져 있음</div>
        {#each r.off as x (x.id)}{@render card(x)}{/each}
      {/if}

      {#if skills.length}
        <div class="group">이 프로젝트에 쓸 만한 설치된 스킬</div>
        {#each skills as k (k.name)}
          <div class="card">
            <div class="crow">
              <span class="badge">스킬</span>
              <span class="name">{k.name}</span>
              {#if k.plugin}<span class="mk">{k.plugin}</span>{/if}
            </div>
            {#if k.description}<div class="why desc" title={k.description}>{k.description}</div>{/if}
          </div>
        {/each}
        <div class="hint">스킬은 필요할 때 Claude가 알아서 불러 써요. 이름을 말해 "○○ 스킬로 해 줘"라고 시켜도 돼요.</div>
      {/if}

      {#if r.on.length}
        <button class="group fold" onclick={() => (showOn = !showOn)}>이미 쓰는 중 {r.on.length}개 {showOn ? "▾" : "▸"}</button>
        {#if showOn}{#each r.on as x (x.id)}{@render card(x)}{/each}{/if}
      {/if}

      {/if}

      {#if tips.length && !searching}
        <div class="group">토큰 절감 팁</div>
        {#each tips as x (x.id)}
          <div class="card tip">
            <div class="crow"><span class="badge tip">팁</span><span class="name">{x.name}</span></div>
            <div class="why tk">토큰↓ {x.token}</div>
            {#if x.session}<button class="apply" onclick={() => addClaude(cwd || undefined, undefined, "acceptEdits", false, false)}>새 세션 열기</button>{/if}
          </div>
        {/each}
      {/if}

      {#if !scan.catalog.length}
        <div class="hint">설치할 수 있는 플러그인 목록을 못 찾았어요. Claude에서 /plugin 을 한 번 열면 목록이 내려받아져요.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .reco { height: 100%; display: flex; flex-direction: column; }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border-soft); }
  .t { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; }
  .refresh { border: none; background: transparent; color: var(--muted); font-size: 15px; cursor: pointer; }
  .refresh:disabled { opacity: 0.3; cursor: default; }
  .empty { margin: auto; padding: 28px 18px; text-align: center; color: var(--muted); font-size: 12.5px; line-height: 1.6; }
  .sigs { display: flex; flex-wrap: wrap; gap: 5px; padding: 10px 14px 4px; }
  .sig { font-size: 10.5px; padding: 2px 8px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); }
  .list { flex: 1; overflow-y: auto; padding: 8px 12px 14px; }
  .group { display: block; font-size: 10.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; margin: 12px 2px 7px; }
  .group.fold { border: none; background: none; padding: 0; cursor: pointer; font-family: inherit; text-align: left; }
  .group.fold:hover { color: var(--fg); }
  .card { border: 1px solid var(--border-soft); border-radius: 12px; background: var(--surface); padding: 11px 12px; margin-bottom: 9px; }
  .card.done { opacity: 0.72; }
  .card.tip { background: color-mix(in srgb, var(--accent) 5%, var(--surface)); }
  .crow { display: flex; align-items: center; gap: 7px; }
  .badge { font-size: 9.5px; padding: 1px 7px; border-radius: 8px; background: var(--surface-2); color: var(--muted); flex: none; }
  .badge.plugin { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .badge.tip { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .name { font-size: 13px; font-weight: 600; color: var(--fg); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mk { flex: none; font-size: 10px; color: var(--muted); }
  .stt { flex: none; font-size: 10.5px; color: var(--muted); }
  .stt.on { color: var(--ok); }
  .stt.off { color: var(--warn); }
  .why { font-size: 11.5px; line-height: 1.5; margin-top: 6px; color: var(--fg-dim); }
  .why.desc { color: var(--muted); font-size: 11px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .why.sk { color: var(--muted); font-size: 11px; }
  .why.tk { color: var(--accent-2); }
  .acts { display: flex; gap: 6px; margin-top: 9px; }
  .apply { flex: 1; padding: 7px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); color: var(--fg); font-size: 12px; cursor: pointer; }
  .apply.sub { flex: none; padding: 7px 10px; color: var(--muted); }
  .apply:hover { border-color: var(--accent); color: var(--accent); }
  .card.tip .apply { margin-top: 9px; width: 100%; }
  .search { width: calc(100% - 24px); box-sizing: border-box; margin: 10px 12px 0; padding: 6px 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); color: var(--fg); font-size: 12px; }
  .hint { margin: -2px 2px 10px; color: var(--muted); font-size: 11px; line-height: 1.5; }
</style>
