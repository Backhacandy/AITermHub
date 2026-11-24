// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 2인 협업 동시 작업: 둘이 함께 시작하고, 끝난 뒤 상대에게 받은 "요청"이 있는 쪽만 한 번 더 이어서 한다.

/** 인계 메모에 상대가 해 줘야 할 일("요청: …" 줄)이 있는지 */
export function hasRequest(memo: string): boolean {
  return /(^|\n)\s*[-*•]?\s*요청\s*[:：]/.test(memo);
}

/** 후속(요청 처리) 라운드 기본 최대 횟수 — 서로 계속 떠넘기며 끝없이 도는 걸 막는다(설정에서 바꿀 수 있다) */
export const MAX_FOLLOWUPS = 3;

/** 설정의 후속 횟수: 무제한이면 Infinity, 아니면 0 이상 정수(없으면 기본 3) */
export function followupLimit(s: { followupMax?: number; followupUnlimited?: boolean }): number {
  if (s.followupUnlimited) return Infinity;
  const n = s.followupMax;
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MAX_FOLLOWUPS;
}

/**
 * 이번 라운드가 끝난 뒤 이어서 할 에이전트(받을 쪽 기준 메모).
 * 이번 지시에 참여한 쪽은 '요청:'을 받았으면, 참여하지 않은 쪽은 "요청: @이름"으로 콕 집혔을 때(woken)만.
 */
export function followups<T extends string>(memoFor: Partial<Record<T, string>>, round: number, members: T[], woken: T[] = [], max = MAX_FOLLOWUPS): T[] {
  if (round >= max) return [];
  const out = members.filter((a) => hasRequest(memoFor[a] ?? ""));
  for (const w of woken) if (!out.includes(w) && hasRequest(memoFor[w] ?? "")) out.push(w);
  return out;
}

/**
 * 범위를 정한 지시인지("기획만", "기획서까지만", "개발하지 마", "구현은 하지 말고") — 이런 지시에서는
 * 인계의 요청으로 다른 에이전트를 깨워 범위 밖 일(구현 등)을 시작하지 않는다. "하지만"·"만약"은 아니다.
 */
export function scopeLimited(text: string): boolean {
  return /(까지만|[가-힣](?<!지)만)(?![가-힣])|(하|건드리|짜|만들|고치|개발하|구현하|진행하|손대)지\s*(마|말)/.test(text);
}

/** 동시에 보냈는데 내 담당에 할 일이 없어 바로 끝낸 답("내 몫 없음") — 인계로 넘기지 않는다 */
export function isNoShare(answer: string): boolean {
  return /^\s*내 몫 없음/.test(answer);
}
