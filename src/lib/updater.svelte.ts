// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 배포판 자동 업데이트: 시작 10초 뒤와 하루에 한 번 GitHub 릴리스를 확인해 새 버전을 알려 준다.
// 설치는 사용자가 눌러야 한다. 일하는 세션이 있으면 "일이 끝난 뒤"를 고를 수 있다(끝나면 설치하고 다시 시작 — 하던 일은 재시작 이어 하기가 잇는다).
// 개발판은 확인하지 않는다.
import { flavor } from "./flavor";

export interface UpdateDeps {
  /** 새 버전이 있으면 {version}, 없으면 null */
  check: () => Promise<{ version: string } | null>;
  /** 받은 새 버전을 내려받아 설치 */
  install: () => Promise<void>;
  relaunch: () => Promise<void>;
  /** 지금 일하는 세션이 있는지 */
  busy: () => boolean;
}

/** 일하는 중: 답하는 중인 탭(working) 또는 에이전트가 띄운 백그라운드 작업(빌드·개발 서버 등) */
export function isBusy(working: Record<string, unknown>, background: Record<string, unknown>): boolean {
  return Object.keys(working).length > 0 || Object.values(background).some(Boolean);
}

export const upd = $state<{ available: string | null; deferred: boolean; installing: boolean; error: string }>({
  available: null,
  deferred: false,
  installing: false,
  error: "",
});

let idleTimer: ReturnType<typeof setInterval> | undefined;

export function resetForTest() {
  upd.available = null;
  upd.deferred = false;
  upd.installing = false;
  upd.error = "";
  clearInterval(idleTimer);
  idleTimer = undefined;
}

export async function checkNow(d: UpdateDeps): Promise<void> {
  try {
    const u = await d.check();
    if (u) upd.available = u.version;
  } catch {
    // 오프라인·GitHub 응답 이상 — 다음 확인 때 다시
  }
}

export async function installNow(d: UpdateDeps): Promise<void> {
  if (!upd.available || upd.installing) return;
  upd.installing = true;
  upd.error = "";
  try {
    await d.install();
    await d.relaunch();
  } catch (e) {
    upd.error = `업데이트하지 못했어요: ${e instanceof Error ? e.message : e}`;
  } finally {
    upd.installing = false;
  }
}

/** 일하는 세션이 없어질 때까지 1분마다 보고, 없어지면 설치 */
export function installWhenIdle(d: UpdateDeps): void {
  upd.deferred = true;
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (d.busy()) return;
    clearInterval(idleTimer);
    idleTimer = undefined;
    upd.deferred = false;
    void installNow(d);
  }, 60_000);
}

export function dismiss() {
  upd.available = null;
  upd.deferred = false;
  clearInterval(idleTimer);
}

const DAY = 24 * 60 * 60_000;
let started = false;
/** 앱 시작 때 한 번. 개발판이면 아무것도 하지 않는다 */
export function startUpdateWatch(d: UpdateDeps): void {
  if (started || flavor() !== "release") return;
  started = true;
  setTimeout(() => void checkNow(d), 10_000);
  setInterval(() => void checkNow(d), DAY);
}
