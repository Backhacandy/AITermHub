<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 모바일 패널: 프로젝트 폴더를 폰(Claude 앱 Code 탭·claude.ai/code)에서 열 수 있게 켜고 끈다.
  import { onMount } from "svelte";
  import { tabs } from "$lib/sessions.svelte";
  import { settings } from "$lib/settings.svelte";
  import { acc, loadAccounts } from "$lib/accounts.svelte";
  import { rem, listenRemotes, remoteOf, sameDir, startRemote, stopRemote, STATUS_LABEL } from "$lib/remote.svelte";
  import Icon from "./Icon.svelte";

  onMount(() => {
    void listenRemotes();
    if (!acc.loaded) void loadAccounts();
  });

  // 열린 탭의 폴더 + 켜 둔 폴더(탭을 닫았어도)
  let dirs = $derived.by(() => {
    const out: string[] = [];
    const add = (d?: string) => d && !out.some((x) => sameDir(x, d)) && out.push(d);
    tabs.forEach((t) => add(t.cwd));
    (settings.remoteDirs ?? []).forEach(add);
    rem.list.forEach((r) => r.status !== "stopped" && add(r.cwd));
    return out;
  });

  const nameOf = (d: string) => d.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || d;
  const isOn = (d: string) => {
    const r = remoteOf(d);
    return !!r && r.status !== "stopped";
  };

  let email = $derived.by(() => {
    const cl = acc.list.filter((a) => a.cli === "claude" && a.enabled);
    return (cl.find((a) => a.active) ?? cl.find((a) => !a.home) ?? cl[0])?.email ?? null;
  });

  async function toggle(d: string) {
    if (isOn(d)) await stopRemote(d);
    else await startRemote(d);
  }
  async function allOn() {
    for (const d of dirs) if (!isOn(d)) await startRemote(d);
  }

  let copied = $state("");
  async function copy(url: string) {
    await navigator.clipboard.writeText(url).catch(() => {});
    copied = url;
    setTimeout(() => (copied = ""), 1500);
  }
</script>

<div class="mp">
  <div class="head">
    <span class="t">모바일 원격</span>
    <button class="hb" onclick={allOn} disabled={dirs.every(isOn)} title="열린 탭의 프로젝트를 모두 폰에서 열 수 있게">모두 켜기</button>
  </div>

  <div class="guide">
    <p>폰 <b>Claude 앱 → Code</b> 탭에서 폴더 이름을 고르면 이 PC에서 작업해요.</p>
    <p>메시지 앞에 <code>@co</code>(<code>@codex</code>, <code>@코</code>)를 붙이면 <b>Codex에게만</b> 보내고, 답변과 바뀐 파일이 그대로 돌아와요.</p>
    <p class="dim">
      Claude 앱 계정: <b>{email ?? "확인 중…"}</b> — 지금 쓰는 Claude 계정이에요. 폰도 같은 계정이어야 보여요.
      {settings.fullAccess ? "전체 권한이 켜져 있어 폰에서 시킨 작업도 확인 없이 실행돼요." : "편집은 자동, 명령 실행은 폰에서 승인해요."}
    </p>
  </div>

  {#if rem.err}<div class="err">{rem.err}</div>{/if}

  <div class="list">
    {#each dirs as d (d)}
      {@const r = remoteOf(d)}
      {@const on = isOn(d)}
      <div class="row" class:on>
        <span class="dot {r && on ? r.status : 'stopped'}"></span>
        <div class="info">
          <div class="nm">{nameOf(d)}</div>
          <div class="path" title={d}>{d}</div>
          <div class="st">
            {r && on ? STATUS_LABEL[r.status] : "꺼짐"}{#if r?.error && on}<span class="e"> · {r.error}</span>{/if}
          </div>
        </div>
        {#if r?.url && on}
          <button class="ib" title={copied === r.url ? "복사됨" : "claude.ai/code 주소 복사"} aria-label="주소 복사" onclick={() => copy(r.url!)}>
            <Icon name={copied === r.url ? "check" : "external"} size={13} />
          </button>
        {/if}
        <label class="sw" title={on ? "끄기" : "폰에서 열 수 있게 켜기"}>
          <input type="checkbox" checked={on} disabled={rem.busy[d]} onchange={() => toggle(d)} />
          <span></span>
        </label>
      </div>
    {:else}
      <div class="empty">프로젝트 폴더로 연 탭이 없어요. 새 세션을 폴더와 함께 열면 여기에 나타나요.</div>
    {/each}
    <p class="foot">켜 둔 폴더마다 Claude가 하나씩 대기해요. 대기 중엔 토큰이 들지 않지만 폴더당 메모리를 수백 MB 써요. 허브를 다시 켜면 자동으로 연결돼요.</p>
  </div>
</div>

<style>
  .mp { display: flex; flex-direction: column; height: 100%; }
  .head { display: flex; align-items: center; justify-content: space-between; height: 38px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border); }
  .t { font-size: 12px; font-weight: 600; color: var(--fg-dim); }
  .hb { height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--fg-dim); font-size: 11px; cursor: pointer; }
  .hb:hover:not(:disabled) { color: var(--fg); background: var(--surface-2); }
  .hb:disabled { opacity: .4; cursor: default; }
  .guide { margin: 10px 10px 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); font-size: 11.5px; line-height: 1.55; }
  .guide p { margin: 0 0 5px; }
  .guide p:last-child { margin: 0; }
  .guide code { font-family: var(--mono); font-size: 11px; padding: 0 3px; border-radius: 3px; background: var(--surface-2); }
  .dim { color: var(--muted); font-size: 10.5px; }
  .err { margin: 8px 10px 0; padding: 6px 9px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); font-size: 11.5px; }
  .list { flex: 1; overflow: auto; padding: 10px 10px 14px; }
  .row { display: flex; align-items: center; gap: 9px; padding: 9px 10px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .row.on { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--surface-2); border: 1px solid var(--border); }
  .dot.connected { background: var(--ok); border-color: transparent; }
  .dot.starting { background: var(--warn); border-color: transparent; }
  .dot.error { background: var(--danger); border-color: transparent; }
  .info { flex: 1; min-width: 0; }
  .nm { font-size: 12px; font-weight: 600; }
  .path { font-size: 10.5px; color: var(--muted); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { font-size: 10.5px; color: var(--fg-dim); margin-top: 1px; }
  .st .e { color: var(--danger); }
  .ib { display: grid; place-items: center; width: 24px; height: 22px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
  .ib:hover { color: var(--fg); background: var(--surface-2); }
  .sw { position: relative; width: 28px; height: 16px; flex: none; cursor: pointer; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sw span { position: absolute; inset: 0; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); transition: background .15s; }
  .sw span::after { content: ""; position: absolute; left: 2px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
  .sw input:checked + span { background: var(--accent); border-color: var(--accent); }
  .sw input:checked + span::after { transform: translateX(12px); background: #fff; }
  .sw input:disabled + span { opacity: .6; cursor: wait; }
  .empty { font-size: 11.5px; color: var(--muted); padding: 4px 2px 8px; }
  .foot { font-size: 10.5px; color: var(--muted); line-height: 1.6; margin: 8px 2px 0; }
</style>
