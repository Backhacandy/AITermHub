// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 세션 메모리 통계 + 작업중(출력 활동) 추적
import { listen } from "@tauri-apps/api/event";
import { noteStat } from "./thanksState.svelte";

export interface Stat {
  id: string;
  pid: number;
  suspended: boolean;
  pinned: boolean;
  rss: number; // bytes
  /** 메모리 옆 상태(예: Codex 턴 사이 "대기") */
  note?: string;
}

export const stats = $state<Record<string, Stat>>({});
// 세션별 마지막 출력 시각(ms) — 작업중 판정용
export const lastOutput = $state<Record<string, number>>({});
// 주기 틱(작업중 표시 실시간 갱신용)
export const nowTick = $state({ t: Date.now() });

let started = false;

/** 다음 틱까지(ms): 창이 보이고 최근 3초 안에 출력한 세션이 있으면 빠르게, 아니면 30초(쉬는 동안 화면을 다시 그리지 않게) */
export function tickDelay(now: number, last: Record<string, number>, hidden: boolean): number {
  if (hidden) return 30_000;
  return Object.values(last).some((t) => now - t < 3000) ? 800 : 30_000;
}

let tickTimer: ReturnType<typeof setTimeout> | undefined;
let tickSlow = true;
function tick() {
  nowTick.t = Date.now();
  const d = tickDelay(nowTick.t, lastOutput, typeof document !== "undefined" && document.hidden);
  tickSlow = d > 800;
  clearTimeout(tickTimer);
  tickTimer = setTimeout(tick, d);
}

export async function startStats() {
  if (started) return;
  started = true;

  tick();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", tick);

  await listen<Stat[]>("session-stats", (e) => {
    const incoming = e.payload;
    const ids = new Set(incoming.map((s) => s.id));
    for (const k of Object.keys(stats)) if (!ids.has(k)) delete stats[k];
    for (const s of incoming) {
      noteStat(stats[s.id], s);
      stats[s.id] = s;
    }
  });
}

/** 터미널이 자기 탭 출력을 받을 때 호출(작업중 판정용). */
export function markOutput(id: string) {
  lastOutput[id] = Date.now();
  // 느린 틱이면 바로 깨워 "작업중"이 1초 안에 보이게(창이 숨겨져 있으면 안 깨움 — 보일 때 visibilitychange가 깨운다)
  if (started && tickSlow && !(typeof document !== "undefined" && document.hidden)) tick();
}

/** Claude·Codex·협업 탭이 지금 지시를 처리 중인지(뷰가 알려준다 — 터미널 출력이 없어서) */
export const working = $state<Record<string, boolean>>({});

export function setWorking(id: string, on: boolean) {
  if (on) working[id] = true;
  else delete working[id];
}

/** 답은 끝났는데 에이전트가 띄운 백그라운드 작업(대기 반복·빌드 등)이 아직 도는 탭 — "작업중"과 따로 보여 준다 */
export const background = $state<Record<string, boolean>>({});
export function setBackground(id: string, on: boolean) {
  if (on) background[id] = true;
  else delete background[id];
}

/** 작업중: 구조화 탭은 뷰가 알려준 진행 상태, 터미널 탭은 최근 1.5초 내 출력(nowTick로 실시간 반영). */
export function isBusy(id: string): boolean {
  if (working[id]) return true;
  const t = lastOutput[id];
  return !!t && nowTick.t - t < 1500;
}

export function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0) + " MB";
}
