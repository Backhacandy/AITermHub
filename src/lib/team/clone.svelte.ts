// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 탭에 저장된 에이전트 구성은 반응형 값(프록시)이라 structuredClone이 실패한다 → 평범한 값으로 바꿔 쓴다.
import type { Member } from "./team";

export function plainTeam(team: Member[]): Member[] {
  return $state.snapshot(team) as Member[];
}
