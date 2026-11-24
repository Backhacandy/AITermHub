// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Codex stderr 한 줄을 화면에 어떻게 보일지. Codex는 스스로 다시 시도할 내부 문제도 "ERROR codex_core::…" 로그로 찍어서,
// 전부 빨간 오류로 보이면 작업이 망가진 것처럼 보인다.

export type CodexLine = { kind: "skip" } | { kind: "patch" } | { kind: "note"; text: string } | { kind: "error"; text: string };

/** `2026-10-24T02:30:03.58Z ERROR codex_core::tools::router: error=…` 형태(Codex 내부 로그) */
const INTERNAL = /^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+[\w:]+:\s*(?:error=)?(.*)$/;

export function classifyCodexStderr(line: string): CodexLine {
  if (!line.trim() || /Reading (additional input|prompt) from stdin/.test(line)) return { kind: "skip" };
  const m = line.match(INTERNAL);
  if (!m) return { kind: "error", text: line };
  // 한 패치에 같은 파일을 두 번 넣는 등 패치 형식이 틀려 거부됨 → Codex가 고쳐서 다시 시도한다
  if (/apply_patch verification failed/.test(m[2])) return { kind: "patch" };
  return { kind: "note", text: m[2].trim() };
}

export const PATCH_NOTE = "패치 형식이 틀려 거부됐어요 — Codex가 고쳐서 다시 시도해요";
