<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 포트폴리오: 잔디 폴더의 프로젝트 중 "보이기"로 고른 것만 GitHub 프로필 README에 표로 올린다(처음 보는 프로젝트는 숨김).
  import { onMount } from "svelte";
  import { settings, saveSettings } from "$lib/settings.svelte";
  import { prefKey, visibleItems, renderBlock, type ProjectInfo } from "$lib/portfolio";
  import { scanProjects, getProfile, createProfile, publishPortfolio, draftDesc, type Profile } from "$lib/portfolioRun";
  import Markdown from "$lib/work/Markdown.svelte";

  let scan = $state<ProjectInfo[]>([]);
  let profile = $state<Profile | null>(null);
  let err = $state("");
  let msg = $state("");
  let busy = $state(false);
  let drafting = $state<Record<string, boolean>>({});
  let preview = $state(false);

  const prefs = () => (settings.portfolio ??= {});
  const pref = (dir: string) => (prefs()[prefKey(dir)] ??= {});

  onMount(async () => {
    scan = await scanProjects(settings.grassDirs ?? []).catch(() => []);
    profile = await getProfile().catch((e) => {
      err = String(e);
      return null;
    });
  });

  async function draft(p: ProjectInfo) {
    drafting[p.dir] = true;
    const d = await draftDesc(p).catch(() => "");
    drafting[p.dir] = false;
    if (d) pref(p.dir).desc = d;
    else msg = `${p.name}: 초안을 받지 못했어요`;
  }

  async function publish() {
    busy = true;
    msg = "";
    try {
      await saveSettings();
      msg = await publishPortfolio(settings, () => void saveSettings());
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    busy = false;
  }

  async function makeProfile() {
    busy = true;
    try {
      msg = `만들었어요 — ${await createProfile()}`;
      profile = await getProfile();
    } catch (e) {
      msg = String(e);
    }
    busy = false;
  }

  let block = $derived(renderBlock(visibleItems(scan, settings.portfolio ?? {}), new Date().toLocaleDateString("sv-SE")));
</script>

<div class="pf">
  <div class="acct">
    {#if profile}
      GitHub <b>{profile.login}</b> · 프로필 저장소 {profile.exists ? "있음" : "없음"}
      {#if !profile.exists}<button disabled={busy} onclick={makeProfile} title="공개 저장소 {profile.login}/{profile.login}를 만들어요">프로필 저장소 만들기</button>{/if}
    {:else if err}<span class="err">{err}</span>{:else}확인 중…{/if}
  </div>
  <div class="hint">보이기로 고른 프로젝트만 프로필에 올라가요. 처음 보는 프로젝트는 숨김이에요. 하루 한 번 자동으로 갱신해요.</div>
  {#each scan as p (p.dir)}
    {@const pr = settings.portfolio?.[prefKey(p.dir)]}
    <div class="row" class:on={pr?.show}>
      <label class="show"><input type="checkbox" checked={!!pr?.show} onchange={(e) => (pref(p.dir).show = (e.currentTarget as HTMLInputElement).checked)} /> {p.name}</label>
      <span class="meta">{p.tech.join(" · ") || "—"} · 커밋 {p.commits}</span>
      {#if pr?.show}
        <div class="edit">
          <input placeholder="이름(비우면 폴더 이름)" value={pr?.name ?? ""} oninput={(e) => (pref(p.dir).name = (e.currentTarget as HTMLInputElement).value)} />
          <input class="desc" placeholder="한 줄 설명" value={pr?.desc ?? ""} oninput={(e) => (pref(p.dir).desc = (e.currentTarget as HTMLInputElement).value)} />
          <button disabled={drafting[p.dir]} onclick={() => draft(p)} title="README를 보고 Haiku가 초안을 써요">{drafting[p.dir] ? "…" : "초안"}</button>
        </div>
      {/if}
    </div>
  {/each}
  {#if !scan.length}<div class="hint">잔디 폴더가 없어요. 위 "잔디 폴더"에 프로젝트 폴더를 적어 주세요.</div>{/if}
  <div class="acts">
    <button onclick={() => (preview = !preview)}>미리보기 {preview ? "▾" : "▸"}</button>
    <button class="ok" disabled={busy || !profile?.exists} onclick={publish}>{busy ? "올리는 중…" : "지금 올리기"}</button>
    {#if settings.portfolioAt}<span class="dim">마지막 {new Date(settings.portfolioAt).toLocaleString()}</span>{/if}
  </div>
  {#if msg}<div class="msg">{msg}</div>{/if}
  {#if preview}<div class="pv"><Markdown text={block} /></div>{/if}
</div>

<style>
  .pf { display: flex; flex-direction: column; gap: 8px; padding: 6px 0 12px; font-size: 12.5px; }
  .acct { display: flex; align-items: center; gap: 8px; color: var(--fg-dim); }
  .hint, .dim { color: var(--muted); font-size: 11.5px; line-height: 1.5; }
  .err { color: var(--danger); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 10px; border: 1px solid var(--border-soft); border-radius: 10px; }
  .row.on { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft)); }
  .show { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; }
  .meta { margin-left: auto; color: var(--muted); font-size: 11px; }
  .edit { display: flex; gap: 6px; width: 100%; }
  .edit input { min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--fg); font-size: 12px; }
  .edit input:first-child { width: 140px; flex: none; }
  .edit .desc { flex: 1; }
  button { height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-2); color: var(--fg); font-size: 11.5px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.ok { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .acts { display: flex; align-items: center; gap: 8px; }
  .msg { color: var(--fg-dim); font-size: 11.5px; word-break: break-all; }
  .pv { padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--bg); overflow-x: auto; }
</style>
