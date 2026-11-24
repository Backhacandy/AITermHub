// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 탭의 "하던 일" — 앱이 업데이트·꺼짐으로 다시 켜져도 팀장이 이어서 하게.
// 화면이 몇 초마다 파일(app_data/flight)에 남기고, 다시 켜질 때 한 번 가져가 팀장에게 맡긴다.
// 에이전트는 id(이 앱이 쓴 것) 또는 대화 id(sid — 바깥에서 기록으로 만든 것)로 찾는다.

import type { LeadTurn } from "./leadAgent";
import type { Member } from "./team";

export interface FlightRef { id?: string; sid?: string }
export interface Flight {
  at: number;
  /** 돌던 지시 */
  text: string;
  /** 받았지만 팀장에게 아직 못 간 결과 */
  results: (FlightRef & { name?: string; answer: string })[];
  /** 일하던(끊긴) 에이전트 */
  running: FlightRef[];
  /** 차례를 기다리던(시작 못 한) 에이전트 id */
  pending?: string[];
  /** 팀장이 답하던 차례 · 팀장에게 보내려고 기다리던 차례 */
  lead?: LeadTurn | null;
  queue?: LeadTurn[];
}

/** 하루 지난 것은 버린다(다른 날의 일을 엉뚱하게 이어 하지 않게) */
export const FLIGHT_TTL = 24 * 3600_000;

export const flightEmpty = (f: Flight) =>
  !f.results.length && !f.running.length && !(f.pending?.length) && !f.lead && !(f.queue?.length);

function find(members: Member[], r: FlightRef): Member | undefined {
  const ws = members.filter((m) => !m.lead);
  return (r.id && ws.find((m) => m.id === r.id)) || (r.sid && ws.find((m) => m.resume === r.sid)) || undefined;
}

/** 다시 켰을 때 팀장에게 보낼 차례들: 답하던 차례 → 기다리던 차례 → 끊긴 일·못 간 결과 */
export function resumeTurns(f: Flight | null | undefined, members: Member[], now: number): LeadTurn[] {
  if (!f || !f.at || now - f.at > FLIGHT_TTL) return [];
  const out: LeadTurn[] = [];
  if (f.lead) out.push(f.lead);
  out.push(...(f.queue ?? []));
  const names = (rs: FlightRef[]) => [...new Set(rs.map((r) => find(members, r)?.name).filter((x): x is string => !!x))];
  const results = f.results
    .map((r) => ({ name: find(members, r)?.name ?? r.name ?? "", answer: r.answer }))
    .filter((r) => r.name && r.answer.trim());
  const done = new Set(results.map((r) => r.name));
  const cut = names(f.running).filter((n) => !done.has(n));
  const notStarted = names((f.pending ?? []).map((id) => ({ id }))).filter((n) => !cut.includes(n) && !done.has(n));
  if (results.length || cut.length || notStarted.length)
    out.push({ kind: "results", text: f.text, results, restart: { cut, notStarted } });
  return out;
}
