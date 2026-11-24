<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 에이전트 추가: 직접 고르기(모델·이름·맡을 일·경로) 또는 목적만 적으면 AI가 인원·역할·경로·모델을 제안(확인 후 추가).
  import { LANE_MODELS, EFFORTS } from "$lib/pair/models";
  import { uniqueName, type Member } from "$lib/team/team";
  import { normalizeProposal, proposePrompt, PROPOSE_SCHEMA, PROPOSE_SYSTEM, type Proposal } from "$lib/team/distribute";
  import { quickJson, PROPOSE_MODEL } from "$lib/team/oneshot";

  let { cwd, members, scanDirs, onadd, onclose }: {
    cwd: string;
    members: Member[];
    /** 목적 제안에 넘길 폴더 목록 */
    scanDirs: () => Promise<string[]>;
    /** goal이 있으면 "목적대로 바로 시작" — 각 줄의 task로 바로 일을 시킨다 */
    onadd: (drafts: Proposal[], goal?: string) => void;
    onclose: () => void;
  } = $props();

  let mode = $state<"direct" | "purpose">("direct");
  // 직접
  let cli = $state<"claude" | "codex">("claude");
  let model = $state("auto");
  let name = $state("");
  let purpose = $state("");
  let areas = $state("");
  // 목적
  let goal = $state("");
  let busy = $state(false);
  let err = $state("");
  let drafts = $state<(Proposal & { areaText: string })[]>([]);
  /** 목적대로 바로 시작: AI가 에이전트마다 첫 작업 지시까지 쓰고, 추가하자마자 보낸다 */
  let startNow = $state(false);
  /** AI가 정할 때 쓸 AI(null = 둘 다) */
  let only = $state<"claude" | "codex" | null>(null);

  const lines = (t: string) => t.split(/[\r\n,]+/).map((x) => x.trim()).filter(Boolean);

  function addDirect() {
    const n = name.trim() || (cli === "claude" ? "Claude" : "Codex");
    onadd([{ name: uniqueName(n, members), cli, model, purpose: purpose.trim(), areas: lines(areas), lean: true, task: "" }]);
  }

  async function propose() {
    if (!goal.trim()) return;
    busy = true;
    err = "";
    drafts = [];
    const dirs = await scanDirs().catch(() => [] as string[]);
    const res = await quickJson<unknown>(cwd, PROPOSE_SYSTEM, proposePrompt(goal.trim(), dirs, members, startNow, only), PROPOSE_SCHEMA, PROPOSE_MODEL);
    busy = false;
    const list = res ? normalizeProposal(res, members, only) : [];
    if (!list.length) {
      err = "제안을 받지 못했어요. 목적을 조금 더 구체적으로 적거나 직접 추가해 주세요";
      return;
    }
    drafts = list.map((d) => ({ ...d, areaText: d.areas.join(", ") }));
  }

  function addDrafts() {
    const out: Proposal[] = [];
    for (const d of drafts) {
      const { areaText, ...rest } = d;
      out.push({ ...rest, name: uniqueName(rest.name.trim() || "에이전트", [...members, ...out.map((x, i) => ({ ...x, id: `n${i}` }))]), areas: lines(areaText) });
    }
    if (out.length) onadd(out, startNow && out.some((d) => d.task.trim()) ? goal.trim() : undefined);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKey} />
<div class="back" role="presentation" onclick={onclose}></div>
<div class="aa" role="dialog" aria-label="에이전트 추가">
  <header>
    <b>에이전트 추가</b>
    <span class="tabs">
      <button class:on={mode === "direct"} onclick={() => (mode = "direct")}>직접 고르기</button>
      <button class:on={mode === "purpose"} onclick={() => (mode = "purpose")}>목적만 적기</button>
    </span>
    <button class="x" onclick={onclose} aria-label="닫기">✕</button>
  </header>

  {#if mode === "direct"}
    <div class="form">
      <label>에이전트
        <span class="row">
          <select bind:value={cli} onchange={() => (model = "auto")}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <select bind:value={model}>
            {#each LANE_MODELS[cli] as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
          </select>
        </span>
      </label>
      <label>이름<input bind:value={name} placeholder={cli === "claude" ? "Claude" : "Codex"} /></label>
      <label>맡을 일<input bind:value={purpose} placeholder="예: 로그인·회원가입 화면" /></label>
      <label>담당 경로<textarea rows="3" bind:value={areas} placeholder="한 줄에 하나 · 예: web/login/** · 비우면 맡을 일로 나눠요"></textarea></label>
      <div class="ab"><span class="sp"></span><button onclick={onclose}>취소</button><button class="ok" onclick={addDirect}>추가</button></div>
    </div>
  {:else}
    <div class="form">
      <label>목적<textarea rows="3" bind:value={goal} placeholder="예: 결제·로그인·마이페이지 화면을 빨리 만들고 싶어"></textarea></label>
      <label class="chk"><input type="checkbox" bind:checked={startNow} /> 목적대로 바로 시작 <span class="dim">— AI가 에이전트마다 첫 작업 지시까지 써서, 추가하자마자 보내요</span></label>
      <label>쓸 AI
        <span class="row">
          <select bind:value={only} title="AI가 정할 때 이 AI만 쓰게 해요">
            <option value={null}>Claude·Codex 둘 다</option>
            <option value="claude">Claude만</option>
            <option value="codex">Codex만</option>
          </select>
        </span>
      </label>
      <div class="ab"><span class="dim">AI(Opus)가 필요한 인원과 각자 맡을 일·경로·모델·생각 깊이를 제안해요. 확인하고 추가하세요</span><span class="sp"></span><button class="ok" disabled={busy || !goal.trim()} onclick={propose}>{busy ? "제안 받는 중…" : "제안 받기"}</button></div>
      {#if err}<div class="err">{err}</div>{/if}
      {#if drafts.length}
        <div class="list">
          {#each drafts as d, i (i)}
            <div class="draft">
              <span class="row">
                <input class="nm" bind:value={d.name} />
                <select bind:value={d.cli} onchange={() => { d.model = "auto"; d.effort = undefined; }}>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
                <select bind:value={d.model}>
                  {#each LANE_MODELS[d.cli] as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
                </select>
                <select title="생각 깊이" value={d.effort ?? ""} onchange={(e) => (d.effort = (e.currentTarget as HTMLSelectElement).value || undefined)}>
                  {#each EFFORTS[d.cli] as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
                </select>
                <button class="rm" aria-label="빼기" onclick={() => (drafts = drafts.filter((_, j) => j !== i))}>✕</button>
              </span>
              <input bind:value={d.purpose} placeholder="맡을 일" />
              <input class="mono" bind:value={d.areaText} placeholder="담당 경로(쉼표로)" />
              {#if startNow}<textarea rows="2" bind:value={d.task} placeholder="첫 작업 지시 · 비우면 이 에이전트는 바로 시작하지 않아요"></textarea>{/if}
            </div>
          {/each}
        </div>
        <div class="ab"><span class="sp"></span><button onclick={onclose}>취소</button><button class="ok" onclick={addDrafts}>{drafts.length}명 추가{startNow ? "하고 시작" : ""}</button></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, .25); }
  .aa { position: absolute; top: 40px; left: 50%; transform: translateX(-50%); z-index: 51; width: min(560px, calc(100% - 24px)); max-height: 80%; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); box-shadow: 0 16px 40px rgba(0, 0, 0, .4); font-size: 12px; }
  header { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--border); }
  .tabs { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .tabs button { padding: 3px 10px; border: none; background: transparent; color: var(--muted); font-size: 11.5px; cursor: pointer; }
  .tabs button + button { border-left: 1px solid var(--border); }
  .tabs button.on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--fg); font-weight: 600; }
  .x { margin-left: auto; border: none; background: none; color: var(--muted); cursor: pointer; }
  .form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; overflow-y: auto; }
  label { display: flex; flex-direction: column; gap: 4px; color: var(--fg-dim); }
  .row { display: flex; gap: 6px; align-items: center; }
  input, select, textarea { padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; }
  textarea { resize: vertical; font-family: var(--mono); font-size: 11.5px; }
  .mono { font-family: var(--mono); font-size: 11.5px; }
  .ab { display: flex; gap: 6px; align-items: center; }
  .sp { flex: 1; }
  .ab button { padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font-size: 11.5px; cursor: pointer; }
  .ab button.ok { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
  .ab button:disabled { opacity: .5; cursor: default; }
  .dim { color: var(--muted); font-size: 11px; }
  .chk { flex-direction: row; align-items: center; gap: 6px; color: var(--fg); cursor: pointer; }
  .chk input { margin: 0; }
  .err { color: var(--danger, #e5484d); }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .draft { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
  .draft .nm { flex: 1; font-weight: 600; }
  .rm { border: none; background: none; color: var(--muted); cursor: pointer; }
  .rm:hover { color: var(--danger, #e5484d); }
</style>
