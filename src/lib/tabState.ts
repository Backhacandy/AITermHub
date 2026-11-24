// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 세션 상태 패널의 탭 상태: 작업중 / 백그라운드(답은 끝났고 에이전트가 띄운 백그라운드 작업만 도는 중) / 수면(재웠거나 꺼서 메모리를 비움) / 유휴.

export type TabState = "busy" | "bg" | "sleep" | "idle";

/**
 * main: 그 탭의 주 프로세스 상태(협업 탭은 Claude 쪽). Claude는 쉬면 재우거나 끄므로
 * 프로세스가 없거나 일시정지면 수면. Codex는 지시 사이에 프로세스가 없는 게 정상이라 유휴.
 */
export function tabState(kind: string, busy: boolean, main: { suspended: boolean } | undefined, bg = false): TabState {
  if (busy) return "busy";
  if (bg) return "bg";
  if (kind === "claude" || kind === "pair") return !main || main.suspended ? "sleep" : "idle";
  return main?.suspended ? "sleep" : "idle";
}

/** 팀 탭: Claude 에이전트들(살아 있는 프로세스)의 상태를 하나로 — 하나라도 깨어 있으면 깨어 있음. 없으면 undefined(수면) */
export function teamMain(claudes: { suspended: boolean }[]): { suspended: boolean } | undefined {
  if (!claudes.length) return undefined;
  return { suspended: claudes.every((c) => c.suspended) };
}
