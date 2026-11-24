// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 저장공간 자동 정리 실행기: 30분마다 임시 폴더·쉬는 작업 폴더, 하루 한 번 버린 기록, 5분마다 디스크 경보.
// 판정·삭제는 Rust(storage.rs), 무엇을 지키는지는 열린 탭들이 storageRegistry로 알려 준다.
import { invoke } from "@tauri-apps/api/core";
import { STORAGE_DEFAULTS, diskLevel, driveOf } from "./storagePolicy";
import { collect, noteFor } from "./storageRegistry";

export interface StorageSettings {
  /** 자동 정리(끄면 디스크 경보만) */
  auto: boolean;
  cleanHours: number;
  dirtyHours: number;
  warnGB: number;
  stopGB: number;
  notify(title: string, body: string): void;
}

/** 드라이브별 멈춤 상태("C:" → true) — 팀 탭이 팀원에게 일을 보내기 전에 본다 */
export const disk = $state<{ stopped: Record<string, boolean>; free: Record<string, number> }>({ stopped: {}, free: {} });

/** 이 폴더의 팀이 지금 멈춰야 하는지: C:(앱 데이터·임시·대화 기록)가 바닥나면 모두, 아니면 그 드라이브만 */
export function isStopped(dir: string): boolean {
  return !!disk.stopped["C:"] || !!disk.stopped[driveOf(dir)];
}

const LOGS_KEY = "aith.storageLogsAt";
const GB = 1024 ** 3;
const fmt = (b: number) => `${(b / GB).toFixed(1)}GB`;
let get: (() => StorageSettings) | null = null;
let running = false;
const warned: Record<string, boolean> = {};

type WtResult = { removed: { path: string; freed: number }[]; trimmed: { path: string; freed: number; dirs: string[] }[] };
const short = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;

/** 한 번 정리하고 비운 바이트를 돌려준다. logs: 버린 기록까지(하루 한 번·경보 때) */
export async function sweepNow(reason: "timer" | "warn"): Promise<number> {
  const s = get?.();
  if (!s || !s.auto || running) return 0;
  running = true;
  let freed = 0;
  try {
    const c = collect();
    const t = await invoke<{ freed: number }>("storage_tmp_sweep", { maxHours: STORAGE_DEFAULTS.tmpHours, skip: c.skipLanes }).catch(() => null);
    freed += t?.freed ?? 0;
    const w = await invoke<WtResult>("storage_wt_sweep", { repos: c.repos, skip: c.skipWts, cleanHours: s.cleanHours, dirtyHours: s.dirtyHours }).catch(() => null);
    for (const r of w?.removed ?? []) {
      freed += r.freed;
      noteFor(r.path)?.(`오래 쉰 작업 폴더를 비웠어요: ${short(r.path)} (${fmt(r.freed)}) — 다음에 일을 받으면 다시 만들어요`);
    }
    for (const r of w?.trimmed ?? []) {
      freed += r.freed;
      noteFor(r.path)?.(`오래 쉰 작업 폴더에서 다시 만들 수 있는 것을 지웠어요: ${short(r.path)} · ${r.dirs.join(", ")} (${fmt(r.freed)})`);
    }
    const last = Number(localStorageGet(LOGS_KEY) ?? 0);
    if (reason === "warn" || Date.now() - last >= 24 * 3600_000) {
      const l = await invoke<{ codex: { freed: number }; claude: { freed: number } }>("storage_logs_sweep", {
        keep: c.keepIds,
        roots: c.repos,
        codexHours: STORAGE_DEFAULTS.codexHours,
        claudeDays: STORAGE_DEFAULTS.claudeDays,
      }).catch(() => null);
      if (l) {
        freed += l.codex.freed + l.claude.freed;
        localStorageSet(LOGS_KEY, String(Date.now()));
      }
    }
  } finally {
    running = false;
  }
  return freed;
}

/** 드라이브마다 남은 공간을 보고 경보·멈춤을 정한다 */
async function checkDisk() {
  const s = get?.();
  if (!s) return;
  const c = collect();
  const rows = await invoke<{ drive: string; free: number }[]>("storage_free", { paths: [...c.repos, "C:\\"] }).catch(() => []);
  const th = { warnGB: s.warnGB, stopGB: s.stopGB, resumeGB: Math.max(s.stopGB + 2, STORAGE_DEFAULTS.resumeGB) };
  for (const { drive, free } of rows) {
    disk.free[drive] = free;
    const was = !!disk.stopped[drive];
    const lv = diskLevel(free / GB, was, th);
    if (lv === "ok") warned[drive] = false;
    else if (!warned[drive]) {
      warned[drive] = true;
      const got = await sweepNow("warn");
      s.notify("저장공간", `${drive} 남은 공간이 ${fmt(free)}예요${got ? ` — 정리해서 ${fmt(got)} 비웠어요` : ""}`);
    }
    if (lv === "stop" && !was) s.notify("저장공간", `${drive} 공간이 거의 없어 팀원에게 새 일을 보내지 않고 기다려요(${fmt(free)} 남음)`);
    if (lv !== "stop" && was) s.notify("저장공간", `${drive} 공간이 다시 생겨 기다리던 일을 보내요`);
    disk.stopped[drive] = lv === "stop";
  }
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 저장 못 해도 다음에 다시 돈다 */
  }
}

/** 앱 시작 때 한 번. 설정은 그때그때 읽는다 */
export function startStorage(g: () => StorageSettings) {
  if (get) return;
  get = g;
  setTimeout(() => void checkDisk(), 30_000);
  setTimeout(() => void sweepNow("timer"), 2 * 60_000); // 탭들이 다 열린 뒤
  setInterval(() => void checkDisk(), 5 * 60_000);
  setInterval(() => void sweepNow("timer"), 30 * 60_000);
}
