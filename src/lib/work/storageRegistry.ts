// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 저장공간 정리가 알아야 할 것을 열린 탭이 알려 주는 곳: 프로젝트 폴더, 건드리면 안 되는 작업 폴더·레인, 지킬 대화 id

export interface StorageProvider {
  /** 이 탭이 쓰는 프로젝트(원래) 폴더 */
  repos(): string[];
  /** 지우면 안 되는 팀원 작업 폴더(일하는 중이거나 프로세스가 떠 있음) */
  skipWts(): string[];
  /** 임시 폴더를 건드리면 안 되는 레인 id(`tabId~memberId`, 단독 탭은 탭 id) */
  skipLanes(): string[];
  /** 이어 쓰는 대화 id(Claude 세션·Codex thread) */
  keepIds(): string[];
  /** 이 탭 대화에 한 줄 남기기 */
  note?(text: string): void;
}

const providers = new Map<string, StorageProvider>();

/** 등록하고, 해제 함수를 돌려준다 */
export function register(key: string, p: StorageProvider): () => void {
  providers.set(key, p);
  return () => {
    if (providers.get(key) === p) providers.delete(key);
  };
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export function collect(): { repos: string[]; skipWts: string[]; skipLanes: string[]; keepIds: string[] } {
  const all = [...providers.values()];
  return {
    repos: uniq(all.flatMap((p) => p.repos())),
    skipWts: uniq(all.flatMap((p) => p.skipWts())),
    skipLanes: uniq(all.flatMap((p) => p.skipLanes())),
    keepIds: uniq(all.flatMap((p) => p.keepIds())),
  };
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** 이 경로(작업 폴더)가 속한 프로젝트를 가진 탭의 note */
export function noteFor(path: string): ((text: string) => void) | undefined {
  const p = norm(path);
  for (const v of providers.values()) {
    if (v.note && v.repos().some((r) => p === norm(r) || p.startsWith(`${norm(r)}/`))) return v.note.bind(v);
  }
  return undefined;
}
