// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 화면의 에이전트 카드: 채팅 대신 상태 점 · 지금 하는 일 한 줄 · 마지막 인계만 보여 준다.

import type { LogEntry } from "$lib/work/types";

export type AgentState = "work" | "bg" | "wait" | "rest" | "prep" | "error";

export const STATE_LABEL: Record<AgentState, string> = {
  work: "작업 중",
  bg: "백그라운드 작업 중(끝나면 스스로 이어서 인계)",
  wait: "차례 기다림",
  rest: "쉬는 중",
  prep: "준비 중",
  error: "오류",
};

/** queued: 동시 실행 상한·앞 단계 때문에 차례를 기다림 · bg: 답은 끝냈지만 띄운 빌드·테스트가 아직 돎(끝나면 스스로 이어서 인계) */
export function agentState(o: { ready: boolean; working: boolean; queued: boolean; error: boolean; bg?: boolean }): AgentState {
  if (!o.ready) return "prep";
  // 일하는 중이면 경고 한 줄(stderr)에도 "작업 중" — 오류는 멈췄을 때만
  if (o.working) return "work";
  if (o.bg) return "bg";
  if (o.error) return "error";
  if (o.queued) return "wait";
  return "rest";
}

const MAX = 60;
const short = (t: string) => {
  const name = /[\\/]/.test(t) && !/\s/.test(t) ? t.split(/[\\/]/).pop() || t : t;
  return name.length > MAX ? `${name.slice(0, MAX - 1)}…` : name;
};

/** 일하는 중이면 마지막 도구로 "고치는 중 · 파일" 같은 한 줄, 도구가 아직 없으면 "생각 중" */
export function activityLine(log: LogEntry[], working: boolean): string {
  if (!working) return "";
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind !== "tool") continue;
    const t = short(e.text);
    if (e.verb === "read") return `읽는 중 · ${t}`;
    if (e.verb === "edit") return `고치는 중 · ${t}`;
    if (e.verb === "run") return `실행 중 · ${t}`;
    return t;
  }
  return "생각 중";
}

/** 답의 마지막 "### 인계" 아래 글(다음 "### " 제목 앞까지) */
export function lastHandoff(answer: string): string {
  const i = answer.lastIndexOf("### 인계");
  if (i < 0) return "";
  const rest = answer.slice(i + "### 인계".length).replace(/^[^\n]*\n?/, "");
  const end = rest.search(/^###\s/m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}
