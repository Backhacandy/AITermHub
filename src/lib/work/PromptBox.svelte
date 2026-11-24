<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts">
  // › 지시 입력창. 한글 조합 중 Enter는 전송하지 않는다(isComposing).
  // 작업 중에도 입력창은 열어 둔다. oninterject가 있으면 작업 중에 보낸 말을 이어서 반영하고(터미널의 Claude처럼), 없으면 전송만 막는다.
  // 첨부: 이미지를 붙여 넣으면(Ctrl+V) 프로젝트 .aith/attach에 저장해 경로를, 탐색기에서 파일을 끌어 놓으면 그 경로를 넣는다.
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { attachText, insertText } from "./attach";

  let {
    value = $bindable(""),
    cwd = "",
    disabled = false,
    running = false,
    placeholder = "",
    onsend,
    oncancel,
    oninterject,
  }: {
    value?: string;
    /** 붙여 넣은 이미지를 저장할 프로젝트 폴더(없으면 이미지 붙여넣기 안 함) */
    cwd?: string;
    disabled?: boolean;
    running?: boolean;
    placeholder?: string;
    onsend: () => void;
    oncancel?: () => void;
    /** 작업 중에 보내기(지금 작업에 이어서 반영) */
    oninterject?: () => void;
  } = $props();

  let box: HTMLDivElement;
  let over = $state(false);
  let note = $state("");

  function onkey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!running) onsend();
      else if (oninterject && value.trim()) oninterject();
    }
  }

  function add(text: string) {
    value = insertText(value, text);
  }

  const toBase64 = (f: Blob) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] ?? "");
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    });

  async function onpaste(e: ClipboardEvent) {
    const imgs = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!imgs.length) return;
    e.preventDefault();
    if (!cwd) {
      note = "프로젝트 폴더가 없어 이미지를 저장할 수 없어요";
      return;
    }
    note = "이미지 저장 중…";
    for (const it of imgs) {
      const f = it.getAsFile();
      if (!f) continue;
      const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
      try {
        const path = await invoke<string>("attach_save", { cwd, ext, data: await toBase64(f) });
        add(attachText([path]));
        note = "";
      } catch (err) {
        note = String(err);
      }
    }
  }

  // 탐색기에서 끌어 놓기: 웹뷰가 경로를 주는 이벤트를 받아, 이 입력창 위에 놓였을 때만 넣는다
  onMount(() => {
    let off: (() => void) | undefined;
    let alive = true;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type === "leave") {
            over = false;
            return;
          }
          const r = box?.getBoundingClientRect();
          if (!r || r.width === 0) return;
          const x = p.position.x / devicePixelRatio;
          const y = p.position.y / devicePixelRatio;
          const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          if (p.type === "over" || p.type === "enter") over = inside;
          else if (p.type === "drop") {
            over = false;
            if (inside && p.paths.length) add(attachText(p.paths));
          }
        })
      )
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  });
</script>

<div class="pb" class:over bind:this={box}>
  <textarea
    bind:value
    onkeydown={onkey}
    {onpaste}
    rows="1"
    placeholder={running ? (oninterject ? "작업 중 · 보내면 이어서 반영해요 · Esc 중단" : "작업 중 · Esc 중단") : placeholder}
    title="이미지 붙여넣기 Ctrl+V · 파일 끌어 놓기"
    {disabled}
  ></textarea>
  {#if running && oncancel}
    {#if oninterject && value.trim()}<button class="go" onclick={oninterject} title="지금 작업에 이어서 반영 · Enter">보내기</button>{/if}
    <button class="stop" onclick={oncancel} title="중단 · Esc">중단</button>
  {:else}
    <button class="go" onclick={onsend} disabled={disabled || !value.trim()} title="보내기 · Enter">보내기</button>
  {/if}
</div>
{#if note}<div class="note">{note}</div>{/if}

<style>
  .pb { display: flex; align-items: flex-end; gap: 8px; width: calc(100% - 32px); max-width: 860px; margin: 6px auto 12px; padding: 7px 7px 7px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .pb:focus-within { border-color: var(--accent); }
  .pb.over { border-color: var(--accent); border-style: dashed; background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
  textarea { flex: 1; min-height: 28px; max-height: 180px; padding: 4px 0; border: none; outline: none; resize: none; field-sizing: content; background: transparent; color: var(--fg); font: inherit; font-size: 13.5px; line-height: 20px; }
  textarea::placeholder { color: var(--muted); }
  button { flex: none; height: 28px; padding: 0 12px; border: 1px solid transparent; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
  .go { background: var(--accent); color: var(--accent-fg); }
  .go:disabled { background: var(--surface-2); color: var(--muted); cursor: default; }
  .stop { background: transparent; border-color: var(--danger); color: var(--danger); }
  .stop:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .note { width: calc(100% - 32px); max-width: 860px; margin: -8px auto 8px; font-size: 11px; color: var(--muted); }
</style>
