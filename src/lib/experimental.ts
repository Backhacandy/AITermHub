// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 실험 기능: 팀(여러 에이전트)·Claude vs Codex 비교. 11/24 실측에서 단일 세션보다 느리고 토큰을 더 써서 기본 화면에서 내렸다.
// 설정에서 켠 사람만 새로 만들 수 있다. 이미 열린 팀 탭은 그대로 보이고 동작한다.
import { flavor } from "./flavor";

/** 설정값이 없으면 개발판은 켬(지금 쓰던 그대로), 배포판은 끔 */
export function experimentalOn(s: { experimentalTeam?: boolean }): boolean {
  return s.experimentalTeam ?? flavor() === "dev";
}

/** 팀 만들기를 보여 줄지: 켜져 있거나, 이미 열린 팀 탭이 있으면 */
export function teamEnabled(s: { experimentalTeam?: boolean }, openTeamTabs: number): boolean {
  return experimentalOn(s) || openTeamTabs > 0;
}

export const EXPERIMENTAL_NOTE = "실측상 단일 세션보다 느리고 토큰을 더 쓸 수 있어요";
