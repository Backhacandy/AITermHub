// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 멈춘 명령 풀기: 에이전트가 실행한 명령이 제한 시간을 한참 넘겨도 끝나지 않으면(Windows에서 하위 프로그램이
// 출력을 붙잡는 등) Claude는 계속 기다리고, 앱은 "작업중"으로 보여 아무도 모른다(11/17 MyDocs m3: 8분 제한 명령이 3시간 24분).
// 제한 시간 + 여유가 지나도록 아무 출력이 없으면 앱이 그 차례를 멈추게 하고(interrupt) "이어서 하라"고 보낸다.

/** 아직 결과가 오지 않은 도구 호출 */
export interface OpenTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** 시작 시각(ms) */
  at: number;
}

/** 제한 시간을 넘긴 뒤 더 기다리는 여유 */
export const GRACE_MS = 5 * 60_000;
/** 도구가 없거나 제한을 모르는 도구일 때 "응답 없음"으로 보이기까지 */
export const QUIET_MS = 15 * 60_000;
/** Claude Code Bash 기본·최대 제한 */
const BASH_DEFAULT = 120_000;
const BASH_MAX = 600_000;

/** 그 도구가 스스로 끝나야 하는 시간(ms). 모르면 null(자동으로 풀지 않고 보이기만) */
export function toolLimitMs(t: Pick<OpenTool, "name" | "input">): number | null {
  if (t.name !== "Bash" && t.name !== "PowerShell") return null;
  if (t.input.run_in_background) return 30_000; // 백그라운드로 넘기면 곧바로 돌아온다
  const n = typeof t.input.timeout === "number" && t.input.timeout > 0 ? t.input.timeout : BASH_DEFAULT;
  return Math.min(n, BASH_MAX);
}

export interface StuckVerdict {
  /** 풀어야 할 도구(제한 + 여유를 넘겼고 그동안 출력이 없음) */
  unstick: OpenTool | null;
  /** "응답 없음"으로 보일 분(0이면 정상) */
  quietMin: number;
}

/** 차례가 도는 동안(running) 주기적으로: 마지막 출력 시각과 열린 도구로 판단 */
export function stuckCheck(open: OpenTool[], lastEvent: number, now: number, running: boolean): StuckVerdict {
  if (!running) return { unstick: null, quietMin: 0 };
  const quiet = now - lastEvent;
  let unstick: OpenTool | null = null;
  // 조용해도 정상인 마지막 시각: 도구가 없으면 마지막 출력 + QUIET, 제한을 아는 도구는 그 제한 + 여유,
  // 끝날 때를 모르는 도구(서브에이전트 등)는 자동으로 풀지 않고 QUIET 두 배가 지나야 보이게만
  let okUntil = open.length ? 0 : lastEvent + QUIET_MS;
  for (const t of open) {
    const lim = toolLimitMs(t);
    if (lim === null) {
      okUntil = Math.max(okUntil, lastEvent + 2 * QUIET_MS);
      continue;
    }
    const due = t.at + lim + GRACE_MS;
    if (now > due && quiet > GRACE_MS && !unstick) unstick = t;
    okUntil = Math.max(okUntil, due);
  }
  const quietMin = now > okUntil && quiet > GRACE_MS ? Math.floor(quiet / 60_000) : 0;
  return { unstick, quietMin };
}

/** 풀고 나서 같은 대화로 보내는 말 */
export function unstuckPrompt(t: OpenTool, minutes: number): string {
  const cmd = typeof t.input.command === "string" ? t.input.command.replace(/\s+/g, " ").slice(0, 160) : t.name;
  return `[앱] 방금 실행한 명령이 ${minutes}분째 끝나지 않고 출력도 없어 앱이 멈췄다: ${cmd}
이 명령이 띄운 프로그램이 남아 있으면 정리하라. 같은 일을 다시 하면 시간 제한(timeout 명령 또는 백그라운드 실행 후 결과 파일 확인)을 걸어서 하고, 안 되면 다른 방법으로 한다. 하던 일은 처음부터가 아니라 끊긴 지점부터 이어서 마무리하라.`;
}
