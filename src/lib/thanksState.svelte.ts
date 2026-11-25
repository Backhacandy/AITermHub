// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 응원 부탁 상태: 세션 통계를 받을 때마다 잠든 순간을 재서 쌓고, 조건이 되면 배너가 한 번 보인다.
import { freedOnSleep, addSample, loadThanks, saveThanks, type ThanksState } from "./thanks";

export const thanks = $state<{ s: ThanksState }>({ s: typeof localStorage !== "undefined" ? loadThanks() : { sleeps: 0, freed: 0, asked: false } });

type S = { suspended: boolean; rss: number };

export function noteStat(prev: S | undefined, cur: S) {
  if (thanks.s.asked) return;
  const f = freedOnSleep(prev, cur);
  if (f <= 0) return;
  thanks.s = addSample(thanks.s, f);
  saveThanks(thanks.s);
}

/** 누르든 닫든 다시는 부탁하지 않는다 */
export function markAsked() {
  thanks.s = { ...thanks.s, asked: true };
  saveThanks(thanks.s);
}
