// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 새로 만들기 창의 팀 구성: 맨 앞 팀장(운영 방식의 팀장 모델·생각) + 직접 넣은 에이전트(없으면 팀장 하나로 시작)

import { buildTeam, type Member, type Row } from "./team";
import { leadMember } from "./leadAgent";
import { MODES, modelForMode, type TeamMode } from "./mode";
import type { Areas } from "$lib/pair/route";

export function teamDraft(rows: Row[], mode: TeamMode, areas: Areas): Member[] {
  const p = MODES[mode];
  // 운영 방식이 허용하는 모델 등급까지(라이트는 자동도 Sonnet·GPT-6.1 Sol로 고정)
  // 낮춘 모델은 원래 모델을 기억한다(나중에 맥스로 바꾸면 되돌린다)
  const workers = buildTeam(rows, areas).map((m) => ({ ...m, ...modelForMode(m.cli, m.model, undefined, p.maxTier) }));
  const lead: Member = { ...leadMember(workers), id: "lead", mode, model: p.leadModel, effort: p.leadEffort };
  return [lead, ...workers];
}
