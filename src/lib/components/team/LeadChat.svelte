<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // 팀장과의 대화: 사용자 말·팀장 말·안내 줄, 그리고 확인 요청 카드(기획·배치). 에이전트들의 채팅은 여기 없다.
  import { onMount, onDestroy, tick, untrack } from "svelte";
  import { Sticky } from "$lib/work/stickyScroll";
  import Markdown from "$lib/work/Markdown.svelte";
  import PromptBox from "$lib/work/PromptBox.svelte";
  import { CONFIRM_BUTTONS, type ChatMsg } from "$lib/team/leadChat";

  let {
    msgs,
    thinking,
    value = $bindable(""),
    disabled,
    running,
    cwd,
    placeholder = "팀장에게 지시하기…",
    onsend,
    oncancel,
    oninterject,
    onconfirm,
  }: {
    msgs: ChatMsg[];
    thinking: boolean;
    value?: string;
    disabled: boolean;
    running: boolean;
    cwd: string;
    placeholder?: string;
    onsend: () => void;
    oncancel: () => void;
    oninterject: () => void;
    onconfirm: (id: string, ok: boolean) => void;
  } = $props();

  let list: HTMLDivElement;
  let inner: HTMLDivElement;
  let box: HTMLDivElement;
  // 맨 아래 따라가기(작업 로그와 같은 규칙): 바닥을 보고 있으면 내용이 늦게 커져도(글 렌더링·카드) 끝까지 따라가고,
  // 숨었다 다시 보이면(탭 전환) 바닥으로. 사용자가 위로 올렸을 때만 멈추고 "새 메시지" 버튼을 띄운다
  let sticky: Sticky | undefined;
  let unread = $state(0);
  let seen = 0;
  onMount(() => {
    sticky = new Sticky(list, inner, (atBottom) => {
      if (atBottom) unread = 0;
    });
    seen = msgs.length;
    sticky.toBottom();
  });
  onDestroy(() => sticky?.destroy());
  $effect(() => {
    const n = msgs.length;
    thinking;
    untrack(() => {
      const added = n > seen ? msgs.slice(seen) : [];
      seen = n;
      // 내가 보낸 말·확인 카드는 늘 바닥으로(카드를 놓치지 않게)
      if (!sticky || sticky.atBottom || added.some((m) => m.role === "user" || m.confirm?.state === "open")) {
        unread = 0;
        void tick().then(() => sticky?.toBottom());
      } else if (added.length) unread += added.length;
    });
  });
  function jump() {
    sticky?.toBottom();
    unread = 0;
  }

  function revise(id: string) {
    onconfirm(id, false);
    void tick().then(() => box?.querySelector("textarea")?.focus());
  }

  const DONE: Record<string, string> = { ok: "확인함", revise: "고치기로 함", dropped: "닫힘" };
</script>

<div class="chat">
  <div class="list" bind:this={list}>
    <div class="inner" bind:this={inner}>
    {#if !msgs.length}
      <div class="empty">팀장에게 무엇을 만들지 말해 주세요.<br />팀장이 필요한 에이전트를 꾸려 나눠 맡기고, 결과만 보고해요.</div>
    {/if}
    {#each msgs as m (m.key)}
      {#if m.role === "user"}
        <div class="me">{m.text}</div>
      {:else if m.role === "note"}
        <div class="note">{m.text}</div>
      {:else}
        <div class="lead">
          <div class="who">팀장</div>
          {#if m.text.trim()}<div class="txt"><Markdown text={m.text} /></div>{/if}
          {#if m.confirm}
            {@const c = m.confirm}
            <div class="ask" class:done={c.state !== "open"}>
              <div class="h">확인해 주세요 · {c.title}</div>
              {#if c.body}<div class="b"><Markdown text={c.body} /></div>{/if}
              {#if c.rows?.length}
                <table class="rows">
                  <tbody>
                    {#each c.rows as r, i (i)}
                      <tr><td class="n">{r.name}</td><td>{r.task}</td><td class="c">{r.change ?? ""}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if c.files?.length}<div class="files">{#each c.files as f (f)}<code>{f}</code>{/each}</div>{/if}
              {#if c.state === "open"}
                <div class="btns">
                  <button class="ok" onclick={() => onconfirm(c.id, true)}>{(c.buttons ?? CONFIRM_BUTTONS[c.kind])[0]}</button>
                  <button onclick={() => (c.kind === "plan" || c.kind === "allocation" || c.kind === "other" ? revise(c.id) : onconfirm(c.id, false))}>{(c.buttons ?? CONFIRM_BUTTONS[c.kind])[1]}</button>
                </div>
              {:else}
                <div class="st">{DONE[c.state] ?? ""}</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    {#if thinking}<div class="note think">팀장이 생각 중…</div>{/if}
    </div>
  </div>
  {#if unread > 0}<button class="jump" onclick={jump}>새 메시지 {unread}개 · 아래로</button>{/if}
  <div class="in" bind:this={box}>
    <PromptBox bind:value {cwd} {disabled} {running} {placeholder} {onsend} {oncancel} {oninterject} />
  </div>
</div>

<style>
  .chat { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .inner { display: flex; flex-direction: column; gap: 18px; min-height: 100%; }
  .jump { position: absolute; bottom: 92px; left: 50%; transform: translateX(-50%); padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); font-size: 12px; cursor: pointer; box-shadow: var(--shadow-sm); z-index: 2; }
  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 26px 30px; }
  .empty { margin: auto; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.8; }
  .me { align-self: flex-end; max-width: 78%; padding: 10px 14px; border-radius: 14px 14px 4px 14px; background: var(--surface-2); color: var(--fg); font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .note { align-self: center; color: var(--muted); font-size: 11.5px; text-align: center; }
  .think { animation: blink 1.4s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: 0.45; } }
  .lead { align-self: flex-start; max-width: 88%; display: flex; flex-direction: column; gap: 8px; }
  .who { font-size: 11px; font-weight: 600; color: var(--preset-claude); }
  .txt { padding: 12px 15px; border: 1px solid var(--border-soft); border-radius: 4px 14px 14px 14px; background: var(--surface); font-size: 13px; line-height: 1.7; }
  .ask { padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--warn) 7%, transparent); font-size: 13px; line-height: 1.6; }
  .ask.done { opacity: 0.7; border-color: var(--border); background: var(--surface); }
  .ask .h { margin-bottom: 4px; color: var(--warn); font-size: 12px; font-weight: 600; }
  .rows { width: 100%; margin-top: 10px; border-collapse: collapse; font-size: 12.5px; }
  .rows td { padding: 5px 8px; border-top: 1px solid var(--border-soft); vertical-align: top; }
  .rows .n { font-weight: 600; white-space: nowrap; }
  .rows .c { color: var(--accent); white-space: nowrap; font-size: 11.5px; }
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .files code { padding: 1px 7px; border-radius: 6px; background: var(--surface-2); font-family: var(--mono); font-size: 11.5px; }
  .btns { display: flex; gap: 8px; margin-top: 12px; }
  .btns button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); color: var(--fg); font-size: 12px; cursor: pointer; }
  .btns button.ok { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); }
  .st { margin-top: 8px; color: var(--muted); font-size: 11.5px; }
  .in { flex: none; padding: 0 18px 14px; }
</style>
