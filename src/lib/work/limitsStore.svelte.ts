// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 계정 단위 사용 한도(모든 탭이 공유). 앱을 다시 열어도 마지막 값을 바로 보여주도록 저장해 둔다.
import type { Limits } from "./limits";

export type Provider = "claude" | "codex";

const KEY = "aith.limits";

function load(): Record<Provider, Limits | null> {
  try {
    return { claude: null, codex: null, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { claude: null, codex: null };
  }
}

export const limits = $state<Record<Provider, Limits | null>>(load());

export function updateLimits(p: Provider, l: Limits | null) {
  if (!l) return;
  limits[p] = { ...(limits[p] ?? {}), ...l };
  try {
    localStorage.setItem(KEY, JSON.stringify(limits));
  } catch {
    // 저장 실패(용량·권한)는 표시에 영향 없음
  }
}
