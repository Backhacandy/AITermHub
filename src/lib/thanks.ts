// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// "도움이 됐다면 응원해 주세요"를 딱 한 번, 실제로 도움이 된 뒤에만 부탁한다.
// 탭이 잠드는 순간 그 탭의 메모리가 얼마나 줄었는지(잠들기 직전 값 - 잠든 뒤 값)를 재서 쌓고,
// 3번 이상 재우고 300MB 이상 돌려받았을 때 한 번 보여 준다. 닫거나 누르면 다시 보이지 않는다.
// 기능은 막지 않는다(부탁일 뿐). 값은 이 PC에만 저장하고 어디에도 보내지 않는다.

const MB = 1024 * 1024;
export const ASK_AFTER_SLEEPS = 3;
export const ASK_AFTER_FREED = 300 * MB;
const KEY = "aith.thanks";

export interface ThanksState {
  sleeps: number;
  /** 돌려받은 메모리 합(bytes) */
  freed: number;
  asked: boolean;
}
export const EMPTY: ThanksState = { sleeps: 0, freed: 0, asked: false };

type S = { suspended: boolean; rss: number };

/** 깨어 있던 탭이 이번에 잠들었으면 줄어든 메모리(bytes), 아니면 0 */
export function freedOnSleep(prev: S | undefined, cur: S): number {
  if (!prev || prev.suspended || !cur.suspended) return 0;
  return Math.max(0, prev.rss - cur.rss);
}

/** 잠든 표본 하나를 쌓는다(freed가 0이면 잠든 게 아니므로 그대로) */
export function addSample(s: ThanksState, freed: number): ThanksState {
  if (freed <= 0) return s;
  return { ...s, sleeps: s.sleeps + 1, freed: s.freed + freed };
}

export function shouldAsk(s: ThanksState): boolean {
  return !s.asked && s.sleeps >= ASK_AFTER_SLEEPS && s.freed >= ASK_AFTER_FREED;
}

export function fmtGB(bytes: number): string {
  return bytes < 1024 * MB ? `${Math.round(bytes / MB)}MB` : `${(bytes / (1024 * MB)).toFixed(1)}GB`;
}

export function loadThanks(): ThanksState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.sleeps === "number" && typeof v.freed === "number") return { ...EMPTY, ...v };
  } catch {}
  return { ...EMPTY };
}

export function saveThanks(s: ThanksState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
