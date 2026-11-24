// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 쉬는 Claude 메모리 비우기.
// 1) 잠깐 쉬면 프로세스를 살려 둔 채 재운다(일시정지 + 메모리 반납) — 같은 프로세스라 다음 요청도 서버 캐시를 그대로 쓴다.
// 2) 오래 쉬면 프로세스를 끈다 — 서버 캐시는 1시간이고, 다시 띄우면 요청 앞부분이 바뀌어 캐시를 못 쓰므로 1시간 전에는 끄지 않는다.
//    (실제 기록: 15분 쉬고 와도 캐시 읽기, 다시 띄운 뒤엔 1시간 안이어도 전부 새로 처리)

export const SLEEP_AFTER_MIN = 2;
export const DEFAULT_RELEASE_MIN = 60;
export const MIN_RELEASE_MIN = 60;

type S = { releaseIdle?: boolean; releaseMinutes?: number };

/** bgTasks: Claude가 백그라운드로 돌리는 작업 수(빌드 등) — 답은 끝났어도 일하는 중이라 재우거나 끄면 그 작업도 멈춘다 */
export function sleepDue(lastActive: number, now: number, s: S, bgTasks = 0): boolean {
  if (s.releaseIdle === false || bgTasks > 0) return false;
  return now - lastActive >= SLEEP_AFTER_MIN * 60_000;
}

export function releaseDue(lastActive: number, now: number, s: S, bgTasks = 0): boolean {
  if (s.releaseIdle === false || bgTasks > 0) return false;
  const m = Math.max(MIN_RELEASE_MIN, s.releaseMinutes ?? DEFAULT_RELEASE_MIN);
  return now - lastActive >= m * 60_000;
}

export const RELEASE_NOTE = "— 오래 쉬어서 Claude 프로세스를 껐어요. 다음 지시 때 같은 대화로 다시 시작해요 —";
