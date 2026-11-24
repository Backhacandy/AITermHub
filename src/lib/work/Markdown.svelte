<!-- Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later. -->
<script lang="ts" module>
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  // 링크는 앱 창이 다른 페이지로 넘어가지 않도록 클릭 불가로 바꾸고 주소는 툴팁으로만.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      node.removeAttribute("href");
      node.setAttribute("title", href);
      node.setAttribute("class", "md-link");
    }
  });

  /** AI 답변 마크다운 → 안전한 HTML(스크립트·이벤트 속성 제거) */
  export function renderMarkdown(text: string): string {
    const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "iframe", "form", "input", "img"] });
  }
</script>

<script lang="ts">
  // AI 답변 본문: **굵게**, 표, 목록, 코드 블록 등을 실제 서식으로 보여준다.
  let { text }: { text: string } = $props();
  let html = $derived(renderMarkdown(text));
</script>

<div class="md">{@html html}</div>

<style>
  .md { color: var(--fg-dim); font-size: 14px; line-height: 1.65; word-break: break-word; }
  .md :global(> :first-child) { margin-top: 0; }
  .md :global(> :last-child) { margin-bottom: 0; }
  .md :global(p) { margin: 0 0 8px; }
  .md :global(strong) { color: var(--fg); font-weight: 700; }
  .md :global(em) { font-style: italic; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) { margin: 14px 0 6px; color: var(--fg); line-height: 1.35; }
  .md :global(h1) { font-size: 18px; }
  .md :global(h2) { font-size: 16px; }
  .md :global(h3), .md :global(h4) { font-size: 14.5px; }
  .md :global(ul), .md :global(ol) { margin: 4px 0 8px; padding-left: 22px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(li > p) { margin: 0; }
  .md :global(blockquote) { margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--border); color: var(--muted); }
  .md :global(hr) { border: none; border-top: 1px solid var(--border-soft); margin: 12px 0; }
  .md :global(code) { padding: 1px 5px; border-radius: 5px; background: var(--surface-2); color: var(--fg); font-family: var(--mono); font-size: 12.5px; }
  .md :global(pre) { margin: 6px 0 10px; padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: 8px; background: var(--term-bg); overflow-x: auto; }
  .md :global(pre code) { padding: 0; background: none; color: var(--term-fg); font-size: 12px; line-height: 1.5; }
  .md :global(table) { margin: 6px 0 10px; border-collapse: collapse; font-size: 13px; display: block; overflow-x: auto; max-width: 100%; }
  .md :global(th), .md :global(td) { padding: 5px 10px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
  .md :global(th) { background: var(--surface); color: var(--fg); font-weight: 600; }
  .md :global(tr:nth-child(even) td) { background: color-mix(in srgb, var(--surface) 45%, transparent); }
  .md :global(.md-link) { color: var(--accent); text-decoration: underline; cursor: help; }
</style>
