// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀원 작업 폴더를 일을 받을 때 원래 브랜치에 맞춘다(합친 직후 모두 다시 쓰지 않게). 맞추지 못하면 그 팀원이 먼저 풀게 지시 앞에 붙일 글

/** err: team_sync의 오류("CONFLICT: a.cs, b.cs" 또는 그 밖) */
export function syncNote(base: string, err: string): string {
  const m = /CONFLICT:\s*(.*)$/s.exec(err);
  if (m) return `[앱] 원래 브랜치(${base})를 합치다 충돌이 났다(파일: ${m[1].trim()}). 먼저 git merge ${base}로 합치고 충돌을 푼 뒤 아래 일을 하라.`;
  return `[앱] 원래 브랜치(${base})를 합치지 못했다(${err}). 먼저 git merge ${base}로 맞춘 뒤 아래 일을 하라.`;
}
