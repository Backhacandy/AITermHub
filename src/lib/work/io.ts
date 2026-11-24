// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 작업 화면 파일 접근(invoke 래퍼). 실패는 null로 — 화면은 "읽기 실패"로 표시한다.
import { invoke } from "@tauri-apps/api/core";
import type { ReadResult, WorkIO } from "./types";

const MAX_READ = 2_000_000;

export function tauriIO(cwd: string): WorkIO {
  return {
    read: (path) => invoke<ReadResult>("work_read", { path, maxBytes: MAX_READ }).catch(() => null),
    baseline: (path) => invoke<string | null>("file_baseline", { cwd, path }).catch(() => null),
  };
}

/** 로컬 에이전트용: 읽기도 백엔드에서 root 안으로 제한 */
export function agentIO(root: string): WorkIO {
  return {
    read: (path) => invoke<ReadResult>("agent_work_read", { root, path, maxBytes: MAX_READ }).catch(() => null),
    baseline: (path) => invoke<string | null>("file_baseline", { cwd: root, path }).catch(() => null),
  };
}
