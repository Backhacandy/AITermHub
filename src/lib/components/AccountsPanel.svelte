<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 👤 계정 패널: 등록한 Claude/Codex 계정 카드 — 남은 한도, 켜기/끄기, 사용 우선순위(작업 중엔 고정), 추가·로그인·삭제.
  import { onMount, onDestroy } from "svelte";
  import {
    acc, accountLabel, activateAccount, addAccount, anyBusy, canDisable, isExhausted, listenBusy, loadAccounts, loginSpec,
    moveAccount, refreshAccount, refreshAll, removeAccount, setEnabled, toLimits, type Account, type Cli,
  } from "$lib/accounts.svelte";
  import { fmtReset } from "$lib/work/limits";
  import { addSession } from "$lib/sessions.svelte";
  import Icon from "./Icon.svelte";
  import { multiAccount } from "$lib/flavor";

  // 배포판: 기본 계정 하나의 사용량만 보여 준다(추가·전환·순서·끄기 없음)
  const MA = multiAccount();

  const NAME: Record<Cli, string> = { claude: "Claude", codex: "Codex" };

  let now = $state(Date.now());
  let tick: ReturnType<typeof setInterval> | undefined;
  /** 로그인 기다리는 계정 → 확인 타이머 */
  const waiting = new Map<string, ReturnType<typeof setInterval>>();

  onMount(() => {
    listenBusy();
    if (!acc.loaded) void loadAccounts();
    tick = setInterval(() => (now = Date.now()), 30_000);
  });
  onDestroy(() => {
    clearInterval(tick);
    waiting.forEach((t) => clearInterval(t));
  });

  const group = (cli: Cli) => acc.list.filter((a) => a.cli === cli);
  let busy = $derived(anyBusy());

  /** 로그인 터미널을 띄우고, 로그인이 끝나면 카드를 자동으로 새로고침 */
  async function openLogin(a: { id: string; cli: Cli }, spec?: { program: string; args: string[]; env: [string, string][]; cwd: string | null }) {
    const sp = spec ?? (await loginSpec(a.id).catch(() => null));
    if (!sp) return;
    addSession({
      title: `${NAME[a.cli]} 로그인`,
      preset: a.cli,
      program: sp.program,
      args: sp.args,
      cwd: sp.cwd ?? undefined,
      env: sp.env,
      kind: "term",
      transient: true,
    });
    clearInterval(waiting.get(a.id));
    let n = 0;
    // 로그인 상태 확인은 가벼운 명령(auth status / app-server)이라 몇 초마다 확인해도 토큰이 들지 않는다
    const t = setInterval(async () => {
      n++;
      await refreshAccount(a.id);
      const cur = acc.list.find((x) => x.id === a.id);
      if (!cur || cur.loggedIn || n > 60) {
        clearInterval(t);
        waiting.delete(a.id);
      }
    }, 6000);
    waiting.set(a.id, t);
  }

  async function add(cli: Cli) {
    const r = await addAccount(cli);
    if (r) await openLogin({ id: r.id, cli }, r);
  }

  async function del(a: Account) {
    if (!confirmId || confirmId !== a.id) {
      confirmId = a.id;
      setTimeout(() => confirmId === a.id && (confirmId = null), 4000);
      return;
    }
    confirmId = null;
    await removeAccount(a.id);
  }
  let confirmId = $state<string | null>(null);

  const left = (pct?: number) => (typeof pct === "number" ? Math.max(0, Math.round(100 - pct)) : null);
  const ago = (s?: number) => {
    if (!s) return "";
    const m = Math.round((now / 1000 - s) / 60);
    return m < 1 ? "방금 확인" : m < 60 ? `${m}분 전 확인` : `${Math.round(m / 60)}시간 전 확인`;
  };
</script>

<div class="ap">
  <div class="head">
    <span class="t">{MA ? "계정" : "사용량"}</span>
    <button class="hb" title="모든 계정 새로고침" onclick={refreshAll} disabled={acc.loading}><Icon name="refresh" size={12} />모두 새로고침</button>
  </div>
  {#if acc.err}<div class="err">{acc.err}</div>{/if}
  {#if busy && MA}<div class="lock">작업 중에는 순서와 계정을 바꿀 수 없어요</div>{/if}

  <div class="list">
    {#each ["claude", "codex"] as const as cli (cli)}
      <section>
        <div class="sh"><i class="pd {cli}"></i>{NAME[cli]}{#if MA}<span class="dim" title="위에서부터 사용 · 한도가 차면 다음 계정으로">위에서부터 사용 · 한도가 차면 다음 계정으로</span>{/if}</div>
        {#if !acc.loaded && acc.loading}
          <div class="empty">로그인된 계정을 찾는 중…</div>
        {:else if group(cli).length === 0}
          <div class="empty">이 PC에 로그인된 {NAME[cli]} 계정이 없어요. {MA ? "아래에서 추가하세요." : `터미널에서 ${cli}를 실행해 로그인하세요.`}</div>
        {/if}
        {#each group(cli) as a, i (a.id)}
          {@const lim = toLimits(a.limits)}
          {@const ex = isExhausted(a, now / 1000)}
          {@const using = acc.using[cli] ? acc.using[cli] === a.id : !!a.active}
          <div class="card" class:off={!a.enabled} class:ex class:using>
            <div class="r1">
              <span class="no">#{i + 1}</span>
              <span class="mail" title={a.home ?? "기본 로그인(이 PC의 기본 설정 폴더)"}>{a.loggedIn ? accountLabel(a) : a.email ? `${a.email} · 로그인 필요` : "로그인 필요"}</span>
              {#if a.plan}<span class="plan">{a.plan}</span>{/if}
              {#if !a.home}<span class="tag">기본</span>{/if}
              {#if a.email && group(cli).some((x) => x.id !== a.id && x.email === a.email)}<span class="tag bad" title="다른 카드와 같은 계정이에요">같은 계정</span>{/if}
              {#if using && a.enabled}<span class="tag use">사용 중</span>{/if}
              {#if ex}<span class="tag bad">소진</span>{/if}
              <span class="sp"></span>
              {#if MA}<label class="sw" title={a.enabled && !canDisable(acc.list, a.id) ? "켜진 계정이 최소 하나는 남아야 해요" : a.enabled ? "끄기" : "켜기"}>
                <input type="checkbox" checked={a.enabled} disabled={a.enabled && !canDisable(acc.list, a.id)} onchange={(e) => setEnabled(a.id, (e.currentTarget as HTMLInputElement).checked)} />
                <span></span>
              </label>{/if}
            </div>

            {#if a.loggedIn}
              <div class="bars">
                {#each [["5시간", lim?.fiveHour], ["주간", lim?.weekly]] as const as [nm, w] (nm)}
                  {@const l = left(w?.pct)}
                  <div class="bar">
                    <span class="bl">{nm}</span>
                    <span class="track"><span class="fill" class:low={l !== null && l < 20} style="width:{l ?? 0}%"></span></span>
                    <span class="bv">{l === null ? "—" : `${l}% 남음`}</span>
                    <span class="br">{w ? fmtReset(w.resetsAt, now) : ""}</span>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="need">{a.error && a.error !== "로그인 필요" ? a.error : "로그인하면 한도가 표시돼요"}</div>
            {/if}

            <div class="r3">
              <span class="dim">{a.limits?.checkedAt ? ago(a.limits.checkedAt) : ""}{a.error && a.loggedIn ? ` · ⚠ ${a.error}` : ""}</span>
              <span class="sp"></span>
              {#if MA && !using && a.enabled && a.loggedIn && !ex}
                <button class="use" disabled={busy} title={busy ? "작업 중에는 바꿀 수 없어요" : "열린 탭은 다음 지시부터 이 계정을 써요"} onclick={() => activateAccount(a.id)}>이 계정으로 전환</button>
              {/if}
              {#if MA}<button title="우선순위 올리기" disabled={busy || i === 0} onclick={() => moveAccount(a.id, -1)}><Icon name="up" size={12} /></button>
              <button title="우선순위 내리기" disabled={busy || i === group(cli).length - 1} onclick={() => moveAccount(a.id, 1)}><Icon name="down" size={12} /></button>{/if}
              <button title="새로고침" disabled={acc.refreshing[a.id]} onclick={() => refreshAccount(a.id)}><span class:spin={acc.refreshing[a.id]}><Icon name="refresh" size={12} /></span></button>
              {#if MA && (!a.loggedIn || a.home)}<button title="로그인 터미널 열기" onclick={() => openLogin(a)}><Icon name="key" size={12} /></button>{/if}
              {#if MA && a.home}<button class:warn={confirmId === a.id} title="계정 삭제 · 대화 기록은 남아요" onclick={() => del(a)}>{#if confirmId === a.id}삭제할까요?{:else}<Icon name="trash" size={12} />{/if}</button>{/if}
            </div>
          </div>
        {/each}
        {#if MA}<button class="add" onclick={() => add(cli)}>+ {NAME[cli]} 계정 추가</button>{/if}
      </section>
    {/each}
    {#if MA}<p class="foot">추가한 계정은 전용 폴더에 로그인 정보만 따로 두고, 대화 기록·스킬은 기본 폴더와 공유해서 계정을 바꿔도 지난 기억이 이어져요.</p>{/if}
  </div>
</div>

<style>
  .ap { display: flex; flex-direction: column; height: 100%; }
  .head { display: flex; align-items: center; justify-content: space-between; height: 38px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border); }
  .t { font-size: 12px; font-weight: 600; color: var(--fg-dim); }
  .hb { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg-dim); font-size: 11px; cursor: pointer; }
  .hb:hover:not(:disabled) { color: var(--fg); background: var(--surface-2); }
  .err { margin: 8px 10px 0; padding: 6px 9px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); font-size: 11.5px; }
  .lock { margin: 8px 12px 0; font-size: 11px; color: var(--warn); }
  .list { flex: 1; overflow: auto; padding: 10px 10px 14px; }
  section { margin-bottom: 16px; }
  .sh { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; margin: 0 2px 8px; }
  .sh .dim { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .pd { width: 7px; height: 7px; border-radius: 50%; }
  .pd.claude { background: var(--preset-claude); }
  .pd.codex { background: var(--preset-codex); }
  .dim { color: var(--muted); font-size: 10.5px; font-weight: 400; }
  .empty { font-size: 11.5px; color: var(--muted); padding: 4px 2px 8px; }
  .card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 10px 11px 8px; margin-bottom: 6px; }
  .card.using { border-color: color-mix(in srgb, var(--accent) 65%, var(--border)); box-shadow: inset 2px 0 0 var(--accent); }
  .card.off { opacity: .55; }
  .card.ex { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
  .r1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .no { font-size: 10.5px; color: var(--muted); font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .mail { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .plan { font-size: 10.5px; color: var(--muted); text-transform: capitalize; }
  .tag { font-size: 10px; padding: 0 5px; border-radius: var(--radius-sm); border: 1px solid var(--border); color: var(--muted); white-space: nowrap; line-height: 16px; }
  .tag.use { border-color: var(--accent); color: var(--accent); }
  .tag.bad { border-color: var(--danger); color: var(--danger); }
  .sp { flex: 1; }
  .sw { position: relative; width: 28px; height: 16px; flex: none; cursor: pointer; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sw span { position: absolute; inset: 0; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); transition: background .15s; }
  .sw span::after { content: ""; position: absolute; left: 2px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
  .sw input:checked + span { background: var(--accent); border-color: var(--accent); }
  .sw input:checked + span::after { transform: translateX(12px); background: #fff; }
  .sw input:disabled + span { opacity: .6; cursor: not-allowed; }
  .sw input:focus-visible + span { outline: 1px solid var(--accent); outline-offset: 1px; }
  .bars { margin: 9px 0 4px; display: grid; gap: 6px; }
  .bar { display: grid; grid-template-columns: 34px 1fr auto; grid-template-rows: auto auto; column-gap: 8px; row-gap: 1px; align-items: center; font-size: 11px; font-variant-numeric: tabular-nums; }
  .bl { color: var(--muted); }
  .track { height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: inherit; background: var(--fg-dim); transition: width .3s; }
  .fill.low { background: var(--danger); }
  .bv { color: var(--fg); }
  .br { grid-column: 2 / 4; color: var(--muted); font-size: 10px; }
  .need { margin: 8px 0 3px; font-size: 11px; color: var(--muted); }
  .r3 { display: flex; align-items: center; gap: 3px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border-soft); }
  .r3 .dim { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .r3 button { display: grid; place-items: center; min-width: 24px; height: 22px; padding: 0 5px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; }
  .r3 button:hover:not(:disabled) { color: var(--fg); background: var(--surface-2); }
  .r3 button:disabled { opacity: .35; cursor: default; }
  .r3 button.use { padding: 0 8px; border-color: var(--border); color: var(--fg); font-weight: 600; }
  .r3 button.use:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: transparent; }
  .r3 button.warn { color: var(--danger); border-color: var(--danger); }
  .spin { display: grid; animation: rot 1s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .add { width: 100%; height: 30px; border: 1px dashed var(--border); border-radius: var(--radius); background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
  .add:hover { color: var(--fg); border-color: var(--fg-dim); }
  .foot { font-size: 10.5px; color: var(--muted); line-height: 1.6; margin: 4px 2px 0; }
</style>
