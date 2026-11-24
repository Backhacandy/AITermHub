// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 모델 카탈로그: 팀·단일 에이전트가 고르는 모델(이름·CLI·등급·표시). 목록은 여기 한 곳.

export interface ModelInfo {
  id: string;
  cli: "claude" | "codex";
  label: string;
  icon: string;
  /** 1(가벼움)~5(최상위) */
  tier: number;
  color: string;
}

export const MODELS: Record<string, ModelInfo> = {
  opus: { id: "opus", cli: "claude", label: "Opus 5.5", icon: "👑", tier: 5, color: "#8e4a2e" },
  fable: { id: "fable", cli: "claude", label: "Fable 5.2", icon: "✧", tier: 5, color: "#7a3f6b" },
  sonnet: { id: "sonnet", cli: "claude", label: "Sonnet 5.5", icon: "✦", tier: 3, color: "#c46a45" },
  haiku: { id: "haiku", cli: "claude", label: "Haiku 5.5", icon: "⚡", tier: 1, color: "#d98b5e" },
  "gpt-6.2-astra": { id: "gpt-6.2-astra", cli: "codex", label: "GPT-6.2 Astra", icon: "◆", tier: 5, color: "#1f7f5f" },
  "gpt-6-astra": { id: "gpt-6-astra", cli: "codex", label: "GPT-6 Astra", icon: "◆", tier: 5, color: "#1f7f5f" },
  "gpt-6.2-sol": { id: "gpt-6.2-sol", cli: "codex", label: "GPT-6.2 Sol", icon: "◇", tier: 3, color: "#23919f" },
  "gpt-6.1-sol": { id: "gpt-6.1-sol", cli: "codex", label: "GPT-6.1 Sol", icon: "◇", tier: 3, color: "#23919f" },
  "gpt-6-luna": { id: "gpt-6-luna", cli: "codex", label: "GPT-6 Luna", icon: "☾", tier: 1, color: "#3a8f9f" },
};

/** Claude가 시작할 때 알려 주는 실제 모델 이름(claude-sonnet-5-5[1m], claude-haiku-4-5-20251001) → 별칭과 이름표.
 *  별칭(sonnet 등)은 Claude Code 업데이트로 다음 버전을 가리키게 되므로 이름표를 이것으로 맞춘다. 모르는 형식은 null */
export function nameFromId(id: string): { key: string; label: string } | null {
  const m = /^claude-(opus|fable|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(id.trim());
  if (!m) return null;
  const fam = m[1].toLowerCase();
  return { key: fam, label: `${fam[0].toUpperCase()}${fam.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` };
}

/** Codex 모델 이름(gpt-6.2-sol) → 버전·계열. 계열이 등급을 정한다(astra 최상위 · sol 일반 · terra 가벼운 일반 · luna 단순) */
const CODEX_FAMILY: Record<string, { tier: number; icon: string; color: string }> = {
  astra: { tier: 5, icon: "◆", color: "#1f7f5f" },
  sol: { tier: 3, icon: "◇", color: "#23919f" },
  terra: { tier: 2, icon: "▫", color: "#2f8a80" },
  luna: { tier: 1, icon: "☾", color: "#3a8f9f" },
};
export function codexParts(slug: string): { version: number; family: string } | null {
  const m = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/i.exec(slug.trim());
  if (!m || !CODEX_FAMILY[m[2].toLowerCase()]) return null;
  return { version: Number(m[1]), family: m[2].toLowerCase() };
}

/** Codex가 받아 둔 목록으로 카탈로그를 채운다(모르는 계열은 넣지 않음). 새로 넣은 게 있으면 true */
export function addCodexModels(list: { slug: string; label: string }[]): boolean {
  let changed = false;
  for (const { slug, label } of list) {
    const p = codexParts(slug);
    if (!p || MODELS[slug]) continue;
    const f = CODEX_FAMILY[p.family];
    // "GPT-6.2-Sol" → "GPT-6.2 Sol"
    const nice = label.replace(/-(?=[A-Za-z]+$)/, " ");
    MODELS[slug] = { id: slug, cli: "codex", label: nice, icon: f.icon, tier: f.tier, color: f.color };
    changed = true;
  }
  return changed;
}
