<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 처음 켰을 때 세 장: ① Claude Code·Codex 설치 확인 ② 쉬는 세션은 잠든다 ③ 다시 오면 이어진다
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { detect, nextStep, restartHint, INSTALL_CMD, DOCS, type CliStatus } from "$lib/onboarding";

  let { ondone }: { ondone: () => void } = $props();
  let page = $state(0);
  let st = $state<CliStatus | null>(null);
  let checking = $state(false);
  let copied = $state("");

  async function recheck() {
    checking = true;
    st = await detect((names) => invoke<(string | null)[]>("which_cli", { names }));
    checking = false;
  }
  onMount(recheck);

  async function copy(k: "claude" | "codex") {
    await navigator.clipboard.writeText(INSTALL_CMD[k]).catch(() => {});
    copied = k;
    setTimeout(() => (copied = ""), 1500);
  }
  const openDoc = (k: "claude" | "codex") => invoke("open_path", { path: DOCS[k] }).catch(() => {});
  let ready = $derived(st !== null && nextStep(st) === "ready");
</script>

<div class="ob" role="dialog" aria-modal="true" aria-label="처음 시작하기">
  <div class="card">
    {#if page === 0}
      <h2>AITermHub에 오신 걸 환영해요</h2>
      <p>AI 코딩 CLI(Claude Code·Codex)를 여러 개 켜 둬도 PC가 가볍게 유지되도록 돕는 세션 관리자예요. 먼저 CLI가 설치돼 있는지 볼게요.</p>
      {#each ["claude", "codex"] as const as k (k)}
        <div class="row">
          <span class="nm">{k === "claude" ? "Claude Code" : "Codex"}</span>
          {#if st === null}<span class="dim">확인 중…</span>
          {:else if st[k] === "installed"}<span class="ok">설치됨</span>
          {:else}
            <span class="no">없음</span>
            <code>{INSTALL_CMD[k]}</code>
            <button onclick={() => copy(k)}>{copied === k ? "복사됨" : "복사"}</button>
            <button onclick={() => openDoc(k)}>안내</button>
          {/if}
        </div>
      {/each}
      {#if st && !ready}<p class="dim">둘 중 하나만 있어도 돼요. 터미널에서 위 명령으로 설치한 뒤 다시 확인을 눌러 주세요(Node.js가 필요해요). 로그인은 첫 세션을 열면 CLI가 안내해요. {restartHint(st)}</p>{/if}
      <div class="nav">
        <button onclick={recheck} disabled={checking}>다시 확인</button>
        <span class="sp"></span>
        {#if st && !ready}<button onclick={ondone}>건너뛰기</button>{/if}
        <button class="pri" onclick={() => (page = 1)} disabled={!ready}>다음</button>
      </div>
    {:else if page === 1}
      <h2>쉬는 세션은 잠들어요</h2>
      <p>세션이 2분 동안 쉬면 프로세스를 잠재우고 메모리를 돌려줘요. 1시간 넘게 쉬면 프로세스를 꺼요(대화는 남아 있어요). 오른쪽 현황에서 세션별 메모리를 볼 수 있어요.</p>
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
  .nm { width: 100px; font-weight: 600; }
  .ok { color: var(--ok, #6c6); }
  .no { color: var(--danger, #f77); }
  code { font-size: 12px; padding: 2px 6px; border-radius: 4px; background: rgba(127, 127, 127, 0.15); }
  .dim { opacity: 0.7; }
  .nav { display: flex; gap: 8px; margin-top: 16px; }
  .sp { flex: 1; }
  button { font-size: 12.5px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line, #444); background: transparent; color: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .pri { background: var(--accent, #5b7cfa); border-color: transparent; color: #fff; }
</style>
