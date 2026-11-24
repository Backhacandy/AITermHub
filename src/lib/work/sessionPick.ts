// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 탭에 저장할 Claude 대화 번호: 폴더의 최근 대화로 이어 붙였으면 그 번호를 저장해 둔다.
// (Claude가 같은 번호를 알려주면 "바뀌지 않음"으로 보여 저장되지 않았고, 그러면 탭은 계속 "가장 최근 파일"에
//  기대게 된다 → 원격 제어가 만든 빈 기록이 더 최근이 되는 순간 기억이 사라진 것처럼 보였다)
export function sessionToSave(saved: string | undefined, found: string | null): string | null {
  return found && found !== saved ? found : null;
}
