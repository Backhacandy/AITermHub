// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 밤새 모드: 사람이 없는 동안 확인 카드(배치·역할·후속 상한)를 자동 승인하고 합치기도 바로 해 끝까지 돌린다.
// 기획 확인·합치기 대기(직접 고친 파일)·git 저장소 만들기는 사람이 정할 일이라 아침까지 남긴다.
// 안전장치: 정한 시간이 지나거나, 같은 에이전트가 연달아 실패하면 멈춘다.

import type { ConfirmReq } from "./leadChat";

export interface NightState {
  /** 이 시각(ms)까지 */
  until: number;
  /** 에이전트별 연속 실패 수 */
  fails: Record<string, number>;
}

/** 같은 에이전트가 이만큼 연달아 실패하면 멈춘다(헛돌며 토큰을 태우지 않게) */
export const NIGHT_FAILS = 3;
export const NIGHT_HOURS = 8;

export const startNight = (now: number, hours = NIGHT_HOURS): NightState => ({ until: now + hours * 3600_000, fails: {} });

export const nightActive = (n: { until: number } | undefined, now: number): boolean => !!n && now < n.until;

/** 밤새 모드에서 자동으로 승인할 확인 카드 */
export const nightAutoApproves = (kind: ConfirmReq["kind"]): boolean => kind === "allocation" || kind === "other";

/** 에이전트 차례 결과를 센다: 실패면 +1, 되면 0. stop = 연속 실패가 상한에 닿음 */
export function noteResult(fails: Record<string, number>, mid: string, ok: boolean): { fails: Record<string, number>; stop: boolean } {
  const n = ok ? 0 : (fails[mid] ?? 0) + 1;
  return { fails: { ...fails, [mid]: n }, stop: n >= NIGHT_FAILS };
}
