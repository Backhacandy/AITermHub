// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 한도가 다 됐고 바꿀 계정도 없을 때: 그 차례를 끝내지 않고 풀릴 때까지 기다렸다가 같은 지시를 다시 보낸다

/** 풀리는 시각을 모를 때 다시 볼 간격 */
export const LIMIT_RETRY_MS = 30 * 60_000;

/** resetAtMs: 다시 쓸 수 있게 되는 시각(ms) — 그 1분 뒤까지(최소 1분), 모르면 30분 */
export function waitMs(resetAtMs: number | null, now: number): number {
  if (resetAtMs === null) return LIMIT_RETRY_MS;
  return Math.max(60_000, resetAtMs - now + 60_000);
}

/** "15:42" 같은 시각(오늘이 아니면 "11-16 03:00") */
export function atLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}
