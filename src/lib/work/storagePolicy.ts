// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 저장공간 정리 기준과 디스크 경보 판단(순수 함수). 실행은 storageRun.svelte.ts

export const STORAGE_DEFAULTS = {
  /** 깨끗한(커밋 안 한 것·합치지 않은 커밋 없음) 팀원 폴더를 통째로 지우기까지 쉰 시간 */
  cleanHours: 6,
  /** 그 밖의 팀원 폴더에서 다시 만들 수 있는 폴더(Library·빌드·node_modules)만 지우기까지 쉰 시간 */
  dirtyHours: 24,
  /** 에이전트 임시 폴더 항목을 지우기까지 안 바뀐 시간 */
  tmpHours: 6,
  /** 에이전트가 한 번씩 부른 Codex 기록을 지우기까지 */
  codexHours: 6,
  /** 아무도 안 가리키는 팀원 Claude 대화를 지우기까지(일) */
  claudeDays: 14,
  /** 이 아래면 바로 정리하고 알린다(GB) */
  warnGB: 10,
  /** 이 아래면 팀원에게 맡기는 일을 멈춘다(GB) */
  stopGB: 3,
  /** 멈춘 뒤 이 위로 올라와야 다시 보낸다(GB) */
  resumeGB: 5,
};

export type DiskLevel = "ok" | "warn" | "stop";

/** wasStopped: 이 드라이브가 지금 멈춘 상태인지(멈춘 뒤엔 resumeGB를 넘어야 푼다) */
export function diskLevel(freeGB: number, wasStopped: boolean, s: { warnGB: number; stopGB: number; resumeGB: number }): DiskLevel {
  if (freeGB < (wasStopped ? s.resumeGB : s.stopGB)) return "stop";
  return freeGB < s.warnGB ? "warn" : "ok";
}

/** "C:\\x" → "C:" (드라이브가 없으면 "") */
export function driveOf(path: string): string {
  const m = /^([a-zA-Z]):/.exec(path);
  return m ? `${m[1].toUpperCase()}:` : "";
}
