<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { settings, saveSettings } from "$lib/settings.svelte";
  import { experimentalOn, EXPERIMENTAL_NOTE } from "$lib/experimental";
  import About from "./About.svelte";
  import { grassNow, parseDirs, grassEmail } from "$lib/grass";

  // GitHub 잔디 자동 올리기 — 폴더는 한 줄에 하나
  let grassText = $state((settings.grassDirs ?? []).join("\n"));
  let grassMsg = $state("");
  let grassBusy = $state(false);
  async function grassRun() {
    grassBusy = true;
    grassMsg = "올리는 중…";
    const dirs = parseDirs(grassText);
    settings.grassDirs = dirs;
    const email = await grassEmail(settings, () => void saveSettings()).catch((e) => {
      grassMsg = String(e);
      return "";
    });
    if (!email) {
      grassBusy = false;
      return;
    }
    const res = await grassNow(dirs, email, true);
    const up = res.filter((r) => r.result.status === "committed").length;
    const bad = res.filter((r) => r.result.status === "error");
    grassMsg = `${up}곳 올림 · ${res.length - up - bad.length}곳 바뀐 것 없음${bad.length ? ` · ${bad.length}곳 실패(${bad.map((b) => `${b.dir.split(/[\\/]/).pop()}: ${b.result.message}`).join(" / ")})` : ""}`;
    grassBusy = false;
  }
  import Icon from "./Icon.svelte";
  import PortfolioPanel from "./PortfolioPanel.svelte";
  import { updateClis, summarize } from "$lib/cliUpdate";

  // Claude Code·Codex CLI 지금 업데이트
  let cliBusy = $state(false);
  async function cliNow() {
    cliBusy = true;
    const r = summarize(await updateClis());
    settings.cliUpdateAt = Date.now();
    settings.cliUpdateLog = r.text;
    cliBusy = false;
  }
  import { push, randomTopic } from "$lib/notify";

  let { onclose }: { onclose: () => void } = $props();
  /** 운영 방식 자세히 · 고급 묶음 펼치기 */
  let opsMore = $state(false);
  let storageMore = $state(false);
  let adv = $state(false);

  // 명령 목록은 줄바꿈 텍스트로 편집
  function listText(preset: string): string {
    return (settings.commands[preset] ?? []).join("\n");
  }
  function setList(preset: string, text: string) {
    settings.commands[preset] = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 컴퓨터 시작 시 자동 실행(Windows 시작프로그램 등록) — 바로 적용, 저장 버튼과 무관
  let autostart = $state(false);
  let autoErr = $state("");
  onMount(() => {
    invoke<boolean>("autostart_get").then((v) => (autostart = v)).catch(() => {});
  });
  async function setAutostart(on: boolean) {
    autoErr = "";
    try {
      await invoke("autostart_set", { on });
      autostart = on;
    } catch (e) {
      autoErr = String(e);
      autostart = !on;
    }
  }

  // 폰 푸시(ntfy)
  let pushMsg = $state("");
  function onPush() {
    if (settings.pushOn && !settings.pushTopic) settings.pushTopic = randomTopic();
  }
  async function testPush() {
    pushMsg = "보내는 중…";
    try {
      await push("AITermHub", "테스트 알림이에요. 이게 보이면 연결 완료!", 3);
      pushMsg = "보냈어요. 폰에 알림이 왔는지 확인하세요.";
    } catch (e) {
      pushMsg = String(e);
    }
  }

  async function save() {
    await saveSettings();
    onclose();
  }
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="설정">
    <header><span>설정</span><button class="x" aria-label="닫기" onclick={onclose}><Icon name="close" size={14} /></button></header>

    <div class="body">
      <div class="sec">일반</div>
      <div class="field">
        <span>테마</span>
        <div class="seg">
          <button class:on={settings.theme === "dark" || !settings.theme} onclick={() => (settings.theme = "dark")}>모던</button>
          <button class:on={settings.theme === "vs"} onclick={() => (settings.theme = "vs")}>Visual Studio</button>
          <button class:on={settings.theme === "light"} onclick={() => (settings.theme = "light")}>라이트</button>
        </div>
      </div>
      <label class="field">
        <span>글자 크기</span>
        <input type="number" min="9" max="28" bind:value={settings.fontSize} />
      </label>
      <label class="field toggle">
        <span title="최소화된 채로 켜지고 지난 탭을 복원해요">컴퓨터 시작 시 자동 실행</span>
        <input type="checkbox" checked={autostart} onchange={(e) => setAutostart((e.currentTarget as HTMLInputElement).checked)} />
      </label>
      {#if autoErr}<div class="field"><span style="color:var(--danger,#e5484d);font-size:11px">{autoErr}</span></div>{/if}

      <div class="sec">운영 방식</div>
      <div class="field">
        <span title="새로 만드는 팀의 기본값이에요. 팀마다 팀 화면 위에서 바꿀 수 있어요">새 팀 기본</span>
        <div class="seg">
          <button class:on={(settings.defaultMode ?? "lite") === "lite"} onclick={() => (settings.defaultMode = "lite")} title="토큰 아끼기 — 팀장 Sonnet, 최대 4명">라이트</button>
          <button class:on={settings.defaultMode === "max"} onclick={() => (settings.defaultMode = "max")} title="품질·속도 — 팀장 Opus, 인원 제한 없음, 합치기 전 검증. 맥스로 만든 팀은 라이트로 바꿀 수 없어요">맥스</button>
        </div>
      </div>
      <label class="field toggle">
        <span title="Claude는 모든 도구를 확인 없이, Codex는 샌드박스 없이 실행해요. 새로 연 탭부터 적용돼요">에이전트 전체 권한</span>
        <input type="checkbox" bind:checked={settings.fullAccess} />
      </label>
      <label class="field toggle">
        <span title="2분 쉬면 재워서 메모리를 비우고, 오래 쉬면 꺼요. 토큰 손해는 없어요">쉬는 Claude 메모리 비우기</span>
        <input type="checkbox" checked={settings.releaseIdle !== false} onchange={(e) => (settings.releaseIdle = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <label class="field toggle">
        <span title="쉬는 터미널 탭을 재워 메모리를 비워요">터미널 탭 자동 재우기</span>
        <input type="checkbox" bind:checked={settings.autoSleep} />
      </label>
      <button class="more" onclick={() => (opsMore = !opsMore)}>자세히 {opsMore ? "▾" : "▸"}</button>
      {#if opsMore}
        <label class="field sub">
          <span title="서버 캐시가 1시간이라 그보다 일찍 끄면 토큰이 더 들어요">쉬는 Claude 완전히 끄기까지 · 분</span>
          <input type="number" min="60" max="480" value={Math.max(60, settings.releaseMinutes ?? 60)} disabled={settings.releaseIdle === false} onchange={(e) => (settings.releaseMinutes = Math.max(60, Number((e.currentTarget as HTMLInputElement).value) || 60))} />
        </label>
        <label class="field sub">
          <span>터미널 유휴 기준 · 분</span>
          <input type="number" min="1" max="240" bind:value={settings.idleMinutes} disabled={!settings.autoSleep} />
        </label>
        <label class="field sub toggle">
          <span title="Claude가 크롬 확장(Claude in Chrome)으로 브라우저를 열고 눌러 볼 수 있어요. 끄면 어디서도 안 써요. 켜 두면 팀은 운영 방식을 따라요(라이트 끔, 맥스는 필요한 역할만)">Claude in Chrome 쓰기</span>
          <input type="checkbox" checked={settings.claudeChrome !== false} onchange={(e) => (settings.claudeChrome = (e.currentTarget as HTMLInputElement).checked)} />
        </label>
      {/if}

      <div class="sec">저장공간</div>
      <label class="field toggle">
        <span title="에이전트가 쓰고 버린 임시 파일, 오래 쉰 팀원 작업 폴더, 한 번 쓰고 버린 대화 기록을 앱이 치워요. 커밋 안 한 작업과 이어 쓰는 대화는 지워지지 않아요">저장공간 자동 정리</span>
        <input type="checkbox" checked={settings.storageAuto !== false} onchange={(e) => (settings.storageAuto = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <button class="more" onclick={() => (storageMore = !storageMore)}>자세히 {storageMore ? "▾" : "▸"}</button>
      {#if storageMore}
        <label class="field sub">
          <span title="커밋 안 한 것도, 아직 합치지 않은 커밋도 없는 팀원 폴더를 통째로 지워요. 다음에 일을 받으면 다시 만들어요">깨끗한 팀원 폴더 비우기까지 · 시간</span>
          <input type="number" min="1" max="720" value={settings.wtCleanHours ?? 6} disabled={settings.storageAuto === false} onchange={(e) => (settings.wtCleanHours = Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 6))} />
        </label>
        <label class="field sub">
          <span title="커밋 안 한 파일은 그대로 두고, Unity 캐시(Library)·빌드·node_modules처럼 다시 만들 수 있는 것만 지워요">나머지 팀원 폴더 캐시 지우기까지 · 시간</span>
          <input type="number" min="1" max="720" value={settings.wtDirtyHours ?? 24} disabled={settings.storageAuto === false} onchange={(e) => (settings.wtDirtyHours = Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 24))} />
        </label>
        <label class="field sub">
          <span title="이 아래로 떨어지면 바로 정리하고 알려요">디스크 경보 · GB</span>
          <input type="number" min="1" max="500" value={settings.diskWarnGB ?? 10} onchange={(e) => (settings.diskWarnGB = Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 10))} />
        </label>
        <label class="field sub">
          <span title="이 아래로 떨어지면 팀장이 팀원에게 맡기는 일을 보내지 않고 기다려요(지금 일하는 에이전트는 멈추지 않아요)">팀원 일 멈춤 · GB</span>
          <input type="number" min="1" max="100" value={settings.diskStopGB ?? 3} onchange={(e) => (settings.diskStopGB = Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 3))} />
        </label>
      {/if}

      <div class="sec">알림</div>
      <label class="field toggle">
        <span title="작업 완료·오류·한도 소진·확인 요청을 알려요. 보고 있는 탭은 알리지 않아요">PC 알림</span>
        <input type="checkbox" checked={settings.notifyDesktop !== false} onchange={(e) => (settings.notifyDesktop = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <label class="field toggle">
        <span title="폰의 ntfy 앱으로 같은 알림을 받아요">폰 푸시 알림</span>
        <input type="checkbox" bind:checked={settings.pushOn} onchange={onPush} />
      </label>
      {#if settings.pushOn}
        <div class="push">
          <div class="prow">
            <span>주제</span>
            <input class="txt" bind:value={settings.pushTopic} spellcheck="false" />
            <button onclick={() => (settings.pushTopic = randomTopic())}>새로</button>
            <button onclick={testPush}>테스트</button>
          </div>
          <div class="prow">
            <span>서버</span>
            <input class="txt" bind:value={settings.pushServer} placeholder="https://ntfy.sh" spellcheck="false" />
          </div>
          <p>ntfy 앱에서 위 주제를 구독하세요. 프로젝트 이름과 상태만 보내요. 주제 이름은 공유하지 마세요.</p>
          {#if pushMsg}<p class="msg">{pushMsg}</p>{/if}
        </div>
      {/if}

      <div class="sec">기능</div>
      <label class="field toggle">
        <span title="하루 한 번, 일하는 에이전트가 없을 때 Claude Code(claude update)와 Codex(npm)를 최신으로 올려요. 이미 떠 있는 세션은 그대로, 새로 시작하는 세션부터 새 버전을 써요">Claude·Codex CLI 자동 업데이트</span>
        <input type="checkbox" checked={settings.cliAutoUpdate !== false} onchange={(e) => (settings.cliAutoUpdate = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <div class="field grass">
        <div class="grow-row">
          <button disabled={cliBusy} onclick={cliNow}>{cliBusy ? "올리는 중…" : "지금 업데이트"}</button>
          {#if settings.cliUpdateLog}<span class="gmsg">{settings.cliUpdateLog}{settings.cliUpdateAt ? ` · ${new Date(settings.cliUpdateAt).toLocaleString()}` : ""}</span>{/if}
        </div>
      </div>
      <label class="field toggle">
        <span title="왼쪽에 모바일 원격 아이콘이 생겨요. 거기서 폴더를 켜면 폰(claude.ai)에서 그 폴더의 작업을 이어 할 수 있어요">모바일 원격</span>
        <input type="checkbox" checked={!!settings.mobileOn || !!settings.remoteDirs?.length} onchange={(e) => (settings.mobileOn = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <label class="field toggle">
        <span title="적어 둔 폴더(GitHub 저장소와 연결된 git 저장소)의 바뀐 것을 몇 시간마다 커밋해 올려요. 작성자는 GitHub noreply 주소, 50MB 넘는 파일·비밀로 보이는 파일은 빼요">GitHub 잔디 자동 올리기</span>
        <input type="checkbox" checked={settings.grassOn !== false} onchange={(e) => (settings.grassOn = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      {#if settings.grassOn !== false}
        <div class="field grass">
          <span class="dim">잔디 폴더 · 한 줄에 하나</span>
          <textarea rows="4" bind:value={grassText} onchange={() => (settings.grassDirs = parseDirs(grassText))} spellcheck="false"></textarea>
          <div class="grow-row"><button disabled={grassBusy} onclick={grassRun}>지금 올리기</button>{#if grassMsg}<span class="gmsg">{grassMsg}</span>{/if}</div>
        </div>
      {/if}
      <label class="field toggle">
        <span title="GitHub 프로필 첫 화면에 '보이기'로 고른 프로젝트의 이름·한 줄 설명·기간·기술·커밋 수를 표로 올려요. 코드는 올리지 않아요">포트폴리오(프로필 프로젝트 목록)</span>
        <input type="checkbox" checked={!!settings.portfolioOn} onchange={(e) => (settings.portfolioOn = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      {#if settings.portfolioOn}<PortfolioPanel />{/if}

      <div class="sec">실험 기능</div>
      <label class="field toggle">
        <span title="여러 에이전트를 팀장이 나눠 맡기는 팀 탭과 Claude vs Codex 비교 탭을 새로 만들 수 있어요. 이미 연 팀 탭은 이 설정과 관계없이 그대로 보여요">팀 · 비교 탭</span>
        <input type="checkbox" checked={experimentalOn(settings)} onchange={(e) => (settings.experimentalTeam = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <p class="dim">{EXPERIMENTAL_NOTE}</p>

      <button class="sec fold" onclick={() => (adv = !adv)}>고급 {adv ? "▾" : "▸"}</button>
      {#if adv}
        <label class="field toggle">
          <span title="팀장이 결과를 보고 다음 일을 이어 맡기는 횟수를 없애요(토큰이 계속 들 수 있어요 — Esc로 멈춰요)">팀 후속 무제한</span>
          <input type="checkbox" checked={!!settings.followupUnlimited} onchange={(e) => (settings.followupUnlimited = (e.currentTarget as HTMLInputElement).checked)} />
        </label>
        <label class="field">
          <span title="지시 하나에서 팀장이 결과를 보고 이어 맡기는 최대 횟수. 넘으면 확인을 받아요">팀 후속 횟수</span>
          <input type="number" min="0" max="50" value={settings.followupMax ?? 3} disabled={!!settings.followupUnlimited} onchange={(e) => (settings.followupMax = Math.min(50, Math.max(0, Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0))))} />
        </label>
        <label class="field">
          <span title="지난 대화를 다시 읽는 비용이 압축 비용보다 커지면 압축해요(권장). %를 고르면 그 비율에서 압축해요 — 창이 20만 토큰보다 큰 모델도 20만 기준(60% = 12만)">자동 압축 기준</span>
          <select bind:value={settings.compactAt}>
            <option value={-1}>비용 비교</option>
            <option value={0}>끔</option>
            <option value={50}>50%</option>
            <option value={60}>60%</option>
            <option value={70}>70%</option>
            <option value={80}>80%</option>
            <option value={90}>90%</option>
          </select>
        </label>
        <div class="cmds">
          <div class="ct">명령 팔레트 목록</div>
          {#each ["claude", "codex", "powershell"] as preset (preset)}
            <label class="field col">
              <span class="plabel">{preset}</span>
              <textarea
                rows="4"
                value={listText(preset)}
                oninput={(e) => setList(preset, (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </label>
          {/each}
        </div>
      {/if}

      <div class="sec">정보</div>
      <About />
    </div>

    <footer>
      <button class="cancel" onclick={onclose}>취소</button>
      <button class="save" onclick={save}>저장</button>
    </footer>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; justify-content: center; align-items: center; z-index: 50; }
  .modal { width: 520px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
  header { display: flex; justify-content: space-between; align-items: center; height: 52px; padding: 0 14px 0 22px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13.5px; }
  .x { display: grid; place-items: center; width: 26px; height: 26px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
  .x:hover { background: var(--surface-2); color: var(--fg); }
  .body { padding: 4px 22px 18px; overflow-y: auto; }
  .sec { display: block; width: 100%; margin: 20px 0 4px; padding: 0; border: none; background: none; color: var(--muted); font: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-align: left; }
  .sec.fold { cursor: pointer; }
  .sec.fold:hover { color: var(--fg); }
  .more { margin: 6px 0 2px; padding: 0; border: none; background: none; color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer; }
  .more:hover { color: var(--fg); }
  .field.sub > span:first-child { color: var(--fg-dim); }
  .dim { color: var(--muted); font-size: 11.5px; }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 44px; padding: 6px 0; border-bottom: 1px solid var(--border-soft); font-size: 12.5px; }
  .field > span:first-child { color: var(--fg); }
  .field.col { flex-direction: column; align-items: stretch; gap: 6px; }
  .field.grass { flex-direction: column; align-items: stretch; gap: 6px; }
  .field.grass textarea { resize: vertical; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font-family: var(--mono); font-size: 11.5px; }
  .grow-row { display: flex; align-items: center; gap: 8px; }
  .grow-row button { padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font-size: 11.5px; cursor: pointer; }
  .gmsg { color: var(--muted); font-size: 11px; }
  .seg { display: flex; padding: 2px; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .seg button { padding: 4px 11px; border: none; border-radius: calc(var(--radius-sm) - 2px); background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
  .seg button:hover { color: var(--fg); }
  .seg button.on { background: var(--surface-2); color: var(--fg); }
  .field input[type="number"], .field select { width: 96px; height: 28px; padding: 0 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); font: inherit; font-size: 12.5px; }
  .field input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
  .field.toggle { cursor: pointer; }
  .push { padding: 8px 0 10px; border-bottom: 1px solid var(--border-soft); font-size: 12px; }
  .prow { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .prow span { width: 30px; color: var(--muted); font-size: 11.5px; }
  .prow .txt { flex: 1; min-width: 0; height: 26px; padding: 0 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); font-family: var(--mono); font-size: 12px; }
  .prow button { height: 26px; padding: 0 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg-dim); font-size: 11.5px; cursor: pointer; }
  .prow button:hover { color: var(--fg); background: var(--surface-2); }
  .push p { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
  .push p.msg { color: var(--fg-dim); }
  .cmds { margin-top: 12px; }
  .ct { font-size: 11.5px; color: var(--muted); margin-bottom: 8px; }
  .plabel { font-weight: 600; font-size: 12px; }
  textarea { width: 100%; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); font-family: var(--mono); font-size: 12px; resize: vertical; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 22px; border-top: 1px solid var(--border); }
  footer button { height: 30px; padding: 0 16px; border-radius: var(--radius-sm); font-size: 12.5px; cursor: pointer; border: 1px solid var(--border); }
  .cancel { background: transparent; color: var(--fg); }
  .save { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
</style>
