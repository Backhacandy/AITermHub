// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 사용 한도(5시간·주간) 해석과 표시 도우미.
// - Claude: stream-json의 rate_limit_event (utilization 0~1, resetsAt 초)
// - Codex: 세션 파일 token_count.rate_limits (used_percent 0~100, window_minutes, resets_at 초)

export interface LimitWindow {
  /** 사용률 % (0~100) */
  pct: number;
  /** 리셋 시각(ms), 모르면 null */
  resetsAt: number | null;
}

export interface Limits {
  fiveHour?: LimitWindow;
  weekly?: LimitWindow;
}

const secToMs = (s: unknown): number | null => (typeof s === "number" && s > 0 ? s * 1000 : null);

function claudeWindow(x: any): LimitWindow | undefined {
  if (!x || typeof x.utilization !== "number") return undefined;
  return { pct: Math.round(x.utilization * 10000) / 100, resetsAt: secToMs(x.resetsAt) };
}

export function fromClaudeEvent(ev: any): Limits | null {
  const info = ev?.rate_limit_info;
  if (!info) return null;
  const out: Limits = {};
  const w = info.unifiedWindows;
  if (w) {
    const five = claudeWindow(w.five_hour);
    const week = claudeWindow(w.seven_day);
    if (five) out.fiveHour = five;
    if (week) out.weekly = week;
  } else {
    const one = claudeWindow(info);
    if (one && info.rateLimitType === "five_hour") out.fiveHour = one;
    else if (one && typeof info.rateLimitType === "string" && info.rateLimitType.startsWith("seven_day")) out.weekly = one;
  }
  return out.fiveHour || out.weekly ? out : null;
}

/**
 * Claude가 한도로 거절했을 때 계정을 막아 둘 시각(초): 찬 창(사용률 100%)의 초기화 시각 — 둘 다 찼으면 늦은 쪽.
 * 대표 시각(info.resetsAt)은 주간일 때가 있어, 5시간 한도가 풀린 뒤에도 며칠씩 막히던 것을 피한다. 어느 창이 찼는지 모르면 대표 시각
 */
export function rejectResetS(info: any): number | null {
  const w = info?.unifiedWindows;
  const full = [w?.five_hour, w?.seven_day].filter((x) => x && typeof x.utilization === "number" && x.utilization >= 0.995 && typeof x.resetsAt === "number");
  if (full.length) return Math.max(...full.map((x) => x.resetsAt));
  return typeof info?.resetsAt === "number" ? info.resetsAt : null;
}

export function fromCodexRateLimits(rl: any): Limits | null {
  if (!rl) return null;
  const out: Limits = {};
  for (const k of ["primary", "secondary"]) {
    const x = rl[k];
    if (!x || typeof x.used_percent !== "number") continue;
    const win: LimitWindow = { pct: x.used_percent, resetsAt: secToMs(x.resets_at) };
    // 6시간 이하 창은 "5시간" 한도, 그보다 긴 창은 주간 한도로 본다
    if (typeof x.window_minutes === "number" && x.window_minutes <= 360) out.fiveHour = win;
    else out.weekly = win;
  }
  return out.fiveHour || out.weekly ? out : null;
}

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const two = (n: number) => String(n).padStart(2, "0");

export function fmtReset(resetsAt: number | null | undefined, now: number): string {
  if (!resetsAt) return "";
  const diff = resetsAt - now;
  if (diff <= 0) return "곧 리셋";
  if (diff < 24 * 3_600_000) {
    const m = Math.round(diff / 60_000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}시간 ${m % 60}분 후 리셋` : `${m}분 후 리셋`;
  }
  const d = new Date(resetsAt);
  return `${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())} 리셋`;
}

/** 작업 전후 사용률 차이(%p, 소수 1자리). 리셋으로 기간이 바뀌었거나 모르면 null. */
export function limitDelta(before: LimitWindow | undefined, after: LimitWindow | undefined): number | null {
  if (!before || !after || before.resetsAt !== after.resetsAt) return null;
  return Math.max(0, Math.round((after.pct - before.pct) * 10) / 10);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
