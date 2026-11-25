<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 처음 켰을 때 세 장: ① PC에 있는 AI CLI 찾기(로그인 여부는 CLI에게 묻는다) ② 쉬는 세션은 잠든다 ③ 다시 오면 이어진다
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { detect, restartHint, loginLabel, installedIds, readyToGo, type CliStatus } from "$lib/onboarding";
  import { ALL_AIS, type AiEntry } from "$lib/agents/registry";
  import { addInstallTab } from "$lib/sessions.svelte";

  let { ondone }: { ondone: () => void } = $props();
  let page = $state(0);
  let st = $state<CliStatus | null>(null);
  let checking = $state(false);
  let copied = $state("");
  /** 로그인 여부 — 상태 명령이 있는 Claude·Codex만(undefined = 확인 중) */
  let login = $state<Record<string, boolean | null | undefined>>({});

  async function recheck() {
    checking = true;
    st = await detect((names) => invoke<(string | null)[]>("which_cli", { names }));
    checking = false;
    login = {};
    for (const k of ["claude", "codex"] as const)
      if (st[k] === "installed") invoke<boolean | null>("cli_login", { cli: k }).then((v) => (login[k] = v)).catch(() => (login[k] = null));
  }
  onMount(recheck);

  async function copy(a: AiEntry) {
    await navigator.clipboard.writeText(a.install).catch(() => {});
    copied = a.id;
    setTimeout(() => (copied = ""), 1500);
  }
  const openDoc = (a: AiEntry) => invoke("open_path", { path: a.site }).catch(() => {});
  /** 로그인: 터미널 탭에서 로그인 명령을 띄운다(비밀번호 등은 그 CLI가 직접 받는다). 끝나면 다시 확인 */
  const doLogin = (a: AiEntry) => a.loginCmd && addInstallTab(`${a.name} 로그인`, a.loginCmd);
  let ready = $derived(st !== null && readyToGo(st, login));
  let have = $derived(st ? installedIds(st) : []);
  /** 설치된 AI 먼저, 그다음 설치할 수 있는 AI */
  let rows = $derived([...ALL_AIS.filter((a) => have.includes(a.id)), ...ALL_AIS.filter((a) => !have.includes(a.id))]);
</script>

<div class="ob" role="dialog" aria-modal="true" aria-label="처음 시작하기">
  <div class="card">
    {#if page === 0}
      <h2>AITermHub에 오신 걸 환영해요</h2>
      <p>AI 코딩 CLI(Claude Code·Codex·Gemini 등)를 여러 개 켜 둬도 PC가 가볍게 유지되도록 돕는 세션 관리자예요. 이 PC에 있는 AI부터 찾아볼게요.</p>
      <p class="need">AI CLI를 <b>하나 이상</b> 로그인하면 시작할 수 있어요. 어떤 AI든 괜찮아요.</p>
      <div class="list">
        {#each rows as a (a.id)}
          {@const on = have.includes(a.id)}
          <div class="row">
            <span class="nm">{a.name}</span>
            {#if st === null}<span class="dim">확인 중…</span>
            {:else if on && a.loginCmd}
              <span class="ok" class:warn={login[a.id] === false}>{loginLabel(login[a.id])}</span>
              {#if login[a.id] === false}<button onclick={() => doLogin(a)}>로그인</button>{/if}
            {:else if on}<span class="ok">설치됨</span><span class="dim">· 로그인은 처음 열 때 안내</span>
            {:else}
              <span class="dim">설치 안 됨</span>
              <span class="sp"></span>
              <button onclick={() => copy(a)} title={a.install}>{copied === a.id ? "복사됨" : "설치 명령 복사"}</button>
              <button onclick={() => openDoc(a)}>안내</button>
            {/if}
          </div>
        {/each}
      </div>
      {#if st && !ready}<p class="dim">설치는 터미널에 명령을 붙여 넣으면 돼요. 설치나 로그인을 마친 뒤 다시 확인을 눌러 주세요. {restartHint(st)}</p>{/if}
      <div class="nav">
        <button onclick={recheck} disabled={checking}>다시 확인</button>
        <span class="sp"></span>
        {#if st && !ready}<button onclick={ondone} title="터미널 탭만 쓸 때">AI 없이 시작</button>{/if}
        <button class="pri" onclick={() => (page = 1)} disabled={!ready}>다음</button>
      </div>
    {:else if page === 1}
      <h2>쉬는 세션은 잠들어요</h2>
      <p>쉬는 세션은 프로세스를 잠재우고 메모리를 돌려줘요(구조화 Claude 탭은 2분, 터미널 탭은 15분 — 설정에서 바꿀 수 있어요). 1시간 넘게 쉬면 프로세스를 꺼요(대화는 남아 있어요). 오른쪽 현황에서 세션별 메모리를 볼 수 있어요.</p>
      <div class="nav"><button onclick={() => (page = 0)}>이전</button><span class="sp"></span><button class="pri" onclick={() => (page = 2)}>다음</button></div>
    {:else}
      <h2>다시 오면 그대로 이어져요</h2>
      <p>잠든 세션에 다시 지시하면 같은 대화로 이어서 해요. 대화가 길어지면 비용을 따져 알맞을 때 압축해서, 다시 이어 갈 때 드는 토큰을 줄여요. 앱을 껐다 켜도 하던 일을 이어서 해요.</p>
      <div class="nav"><button onclick={() => (page = 1)}>이전</button><span class="sp"></span><button class="pri" onclick={ondone}>시작하기</button></div>
    {/if}
  </div>
</div>

<style>
  .ob { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: grid; place-items: center; z-index: 50; }
  .card { width: min(560px, 92vw); background: var(--bg-elev, #1e1f24); color: inherit; border: 1px solid var(--line, #333); border-radius: 12px; padding: 22px 24px; }
  h2 { margin: 0 0 10px; font-size: 18px; }
  p { line-height: 1.6; font-size: 13.5px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; font-size: 13px; }
  .nm { width: 130px; font-weight: 600; }
  .need { margin: 4px 0 8px; }
  .list { max-height: 300px; overflow-y: auto; padding-right: 4px; }
  .list .row { margin: 0; min-height: 40px; padding: 2px 0; border-bottom: 1px solid rgba(127, 127, 127, 0.12); flex-wrap: nowrap; }
  .ok { color: var(--ok, #6c6); }
  .ok.warn { color: var(--warn, #db6); }
  .dim { opacity: 0.7; }
  .nav { display: flex; gap: 8px; margin-top: 16px; }
  .sp { flex: 1; }
  button { font-size: 12.5px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line, #444); background: transparent; color: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .pri { background: var(--accent, #5b7cfa); border-color: transparent; color: #fff; }
</style>
