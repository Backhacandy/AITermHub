// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 계정 풀(프론트): 카드 목록·우선순위·토글, 실행할 계정 고르기, 한도 소진 시 다음 계정으로 넘기기.
// 저장·한도 조회·실행 환경은 Rust(accounts_*)가 맡고, 여기서는 상태 표시와 전환 흐름만 다룬다.

import { authKind } from "$lib/work/authWait";
import { isNetError } from "$lib/work/netRetry";
import { invoke } from "@tauri-apps/api/core";
import { multiAccount } from "$lib/flavor";
import { emit, listen } from "@tauri-apps/api/event";
import type { Limits, LimitWindow } from "$lib/work/limits";

export type Cli = "claude" | "codex";

/** 백엔드 형식(초 단위) */
interface RawWin {
  pct: number;
  resetsAt?: number | null;
}

export interface Account {
  id: string;
  cli: Cli;
  home: string | null;
  email?: string | null;
  plan?: string | null;
  enabled: boolean;
  loggedIn: boolean;
  limits?: { five?: RawWin; week?: RawWin; checkedAt?: number } | null;
  exhaustedUntil?: number | null;
  error?: string | null;
  /** "이 계정으로 전환"으로 지정한 계정 */
  active?: boolean;
}

export const acc = $state({
  list: [] as Account[],
  loaded: false,
  loading: false,
  /** 새로고침 중인 계정 id */
  refreshing: {} as Record<string, boolean>,
  err: "",
  /** 지금 작업 중인 탭/작업자(창 전체 합산) — 작업 중엔 순서 변경 불가 */
  busy: {} as Record<string, boolean>,
  /** CLI별로 마지막에 쓰기 시작한 계정 id(카드의 "사용 중" 표시) */
  using: {} as Record<string, string>,
});

// ---------- 순수 규칙(테스트 대상) ----------

/** 한도 소진 오류 문구인지(Claude/Codex 공통) */
export function isLimitError(text: string | null | undefined): boolean {
  if (!text) return false;
  // "hit your session/weekly/Opus/usage limit" — Claude가 한도 이름을 바꿔 가며 쓴다
  return /usage limit|hit your (\w+ )?limit|limit (has been )?reached|rate[ _-]?limit(ed)? (reached|exceeded)|usage_limit_reached|rate_limit_exceeded|quota exceeded|out of (credits|usage)|사용 한도|한도(에|를)? (도달|초과)/i.test(text);
}

/** 이 오류가 한도 소진인지: 오류 문구가 한도이거나, 이번 차례에 한도 거절 신호(rejected)를 받았고 오류가 로그인·네트워크 문제가 아닐 때.
 *  거절 신호만 보고 로그인 오류(403 Cloudflare 등)까지 소진으로 보면 계정이 한 시간 동안 '소진'으로 막힌다 */
export function limitHit(rejected: boolean, text: string | null | undefined): boolean {
  if (isLimitError(text)) return true;
  return rejected && !authKind(text) && !isNetError(text);
}

/** 백엔드 한도 → 화면 표시용 Limits(ms) */
export function toLimits(l: Account["limits"]): Limits | null {
  if (!l) return null;
  const w = (x?: RawWin): LimitWindow | undefined => (x && typeof x.pct === "number" ? { pct: x.pct, resetsAt: x.resetsAt ? x.resetsAt * 1000 : null } : undefined);
  const out: Limits = {};
  const five = w(l.five);
  const week = w(l.week);
  if (five) out.fiveHour = five;
  if (week) out.weekly = week;
  return five || week ? out : null;
}

/** 화면 Limits(ms) → 백엔드 형식(초) */
export function fromLimits(l: Limits): NonNullable<Account["limits"]> {
  const w = (x?: LimitWindow): RawWin | undefined => (x ? { pct: x.pct, resetsAt: x.resetsAt ? Math.round(x.resetsAt / 1000) : null } : undefined);
  return { five: w(l.fiveHour), week: w(l.weekly), checkedAt: Math.round(Date.now() / 1000) };
}

/** 같은 CLI 묶음 안에서 위/아래로 옮긴 전체 id 순서 */
export function moved(list: Account[], id: string, dir: -1 | 1): string[] {
  const a = list.find((x) => x.id === id);
  if (!a) return list.map((x) => x.id);
  const group = list.filter((x) => x.cli === a.cli);
  const i = group.indexOf(a);
  const j = i + dir;
  if (j < 0 || j >= group.length) return list.map((x) => x.id);
  const g = [...group];
  [g[i], g[j]] = [g[j], g[i]];
  let k = 0;
  return list.map((x) => (x.cli === a.cli ? g[k++].id : x.id));
}

/** 끌 수 있는지(같은 CLI에 켜진 계정이 하나는 남아야 함) */
export function canDisable(list: Account[], id: string): boolean {
  const a = list.find((x) => x.id === id);
  return !!a && list.some((x) => x.cli === a.cli && x.enabled && x.id !== id);
}

export function isExhausted(a: Account, nowS = Date.now() / 1000): boolean {
  if (a.exhaustedUntil && a.exhaustedUntil > nowS) return true;
  return [a.limits?.five, a.limits?.week].some((w) => !!w && w.pct >= 100 && (!w.resetsAt || w.resetsAt > nowS));
}

/** 이 CLI의 켜진 계정 중 하나라도 다시 쓸 수 있게 되는 가장 이른 시각(초). 지금 쓸 수 있으면 nowS, 모르면 null */
export function nextUsableAt(list: Account[], cli: Cli, nowS: number): number | null {
  const on = list.filter((a) => a.cli === cli && a.enabled && a.loggedIn);
  if (!on.length) return null;
  if (on.some((a) => !isExhausted(a, nowS))) return nowS;
  const at = on.map((a) => {
    const full = [a.limits?.five, a.limits?.week].filter((w) => !!w && w.pct >= 100 && (!w.resetsAt || w.resetsAt > nowS));
    if (full.some((w) => !w!.resetsAt)) return null; // 찬 창의 초기화 시각을 모른다
    return Math.max(a.exhaustedUntil ?? 0, ...full.map((w) => w!.resetsAt!));
  });
  const known = at.filter((x): x is number => x !== null && x > 0);
  return known.length ? Math.min(...known) : null;
}

export function accountLabel(a: Account | undefined | null): string {
  if (!a) return "기본 계정";
  return a.email || (a.home ? "새 계정" : "기본 로그인");
}

// ---------- 백엔드 호출 ----------

function setList(l: Account[]) {
  acc.list = l;
  acc.loaded = true;
  acc.err = "";
}
const fail = (e: unknown) => {
  acc.err = String(e);
};

export async function loadAccounts() {
  if (acc.loading) return;
  acc.loading = true;
  try {
    setList(await invoke<Account[]>("accounts_list"));
  } catch (e) {
    fail(e);
  } finally {
    acc.loading = false;
  }
}

export async function refreshAccount(id: string) {
  acc.refreshing[id] = true;
  try {
    setList(await invoke<Account[]>("accounts_refresh", { id }));
  } catch (e) {
    fail(e);
  } finally {
    delete acc.refreshing[id];
  }
}

export async function refreshAll() {
  await Promise.all(acc.list.filter((a) => a.loggedIn || a.home).map((a) => refreshAccount(a.id)));
}

// ---------- 작업 중 사용량 자동 갱신 ----------
// 실행 중인 Claude는 사용률이 경고선(예: 주간 75%)을 넘을 때만 사용량 이벤트를 보내서, 평소엔 패널이 멈춰 있다.
// → 무언가 일하는 동안 지금 쓰는 계정을 주기적으로 직접 확인한다(Codex는 토큰 0, Claude는 아주 작은 호출).

const STALE_S: Record<string, number> = { claude: 10 * 60, codex: 5 * 60 };

/** 지금 쓰는 계정(using) 중 마지막 확인이 오래된 것 */
export function dueForRefresh(list: Account[], using: Record<string, string>, nowS: number): string[] {
  return Object.values(using).filter((id) => {
    const a = list.find((x) => x.id === id);
    if (!a || !a.enabled) return false;
    return nowS - (a.limits?.checkedAt ?? 0) >= (STALE_S[a.cli] ?? 600);
  });
}

let watchTimer: ReturnType<typeof setInterval> | undefined;
/** 앱 시작 때 한 번. working(): 지금 일하는 탭이 있는지 */
export function startUsageWatch(working: () => boolean) {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (!working() || !acc.loaded) return;
    for (const id of dueForRefresh(acc.list, acc.using, Date.now() / 1000)) if (!acc.refreshing[id]) void refreshAccount(id);
  }, 60_000);
}

export async function setEnabled(id: string, on: boolean) {
  try {
    setList(await invoke<Account[]>("accounts_enable", { id, on }));
  } catch (e) {
    fail(e);
  }
}

export const anyBusy = () => Object.values(acc.busy).some(Boolean);

export async function moveAccount(id: string, dir: -1 | 1) {
  if (anyBusy()) {
    acc.err = "작업 중에는 순서를 바꿀 수 없어요";
    return;
  }
  try {
    setList(await invoke<Account[]>("accounts_order", { ids: moved(acc.list, id, dir) }));
  } catch (e) {
    fail(e);
  }
}

export async function removeAccount(id: string) {
  try {
    setList(await invoke<Account[]>("accounts_remove", { id }));
  } catch (e) {
    fail(e);
  }
}

/** 계정 폴더를 만들고 로그인용 터미널 명령을 돌려준다(화면이 터미널 탭으로 띄움) */
export async function addAccount(cli: Cli): Promise<{ id: string; program: string; args: string[]; env: [string, string][]; cwd: string | null } | null> {
  try {
    const a = await invoke<Account>("accounts_add", { cli });
    acc.list = [...acc.list, a];
    const spec = await invoke<{ program: string; args: string[]; env: [string, string][]; cwd: string | null }>("accounts_login_spec", { id: a.id });
    return { id: a.id, ...spec };
  } catch (e) {
    fail(e);
    return null;
  }
}

export async function loginSpec(id: string) {
  return invoke<{ program: string; args: string[]; env: [string, string][]; cwd: string | null }>("accounts_login_spec", { id });
}

/** 이 계정으로 전환(작업 중이 아닐 때만). 열린 탭은 다음 지시부터 이 계정을 쓴다. */
export async function activateAccount(id: string) {
  if (anyBusy()) {
    acc.err = "작업 중에는 계정을 바꿀 수 없어요";
    return;
  }
  try {
    setList(await invoke<Account[]>("accounts_activate", { id }));
    const a = acc.list.find((x) => x.id === id);
    if (a) acc.using[a.cli] = id;
  } catch (e) {
    fail(e);
  }
}

export async function pickAccount(cli: Cli): Promise<string | null> {
  return invoke<string | null>("accounts_pick", { cli }).catch(() => null);
}

export async function noteLimits(id: string, l: Limits | null) {
  if (!l) return;
  try {
    setList(await invoke<Account[]>("accounts_note", { id, limits: fromLimits(l) }));
  } catch {
    // 표시용 갱신 실패는 무시
  }
}

export async function exhaustAccount(id: string, untilS?: number | null) {
  try {
    setList(await invoke<Account[]>("accounts_exhaust", { id, until: untilS ?? null }));
  } catch (e) {
    fail(e);
  }
}

// ---------- 작업 중 표시(창 간 공유) ----------

export function setBusy(key: string, on: boolean) {
  if (!!acc.busy[key] === on) return;
  if (on) acc.busy[key] = true;
  else delete acc.busy[key];
  emit("aith-busy", { key, on }).catch(() => {});
}

let busyListening = false;
/** 다른 창(AI 회사)의 작업 중 표시도 받는다 */
export function listenBusy() {
  if (busyListening) return;
  busyListening = true;
  listen<{ key: string; on: boolean }>("aith-busy", (e) => {
    if (e.payload.on) acc.busy[e.payload.key] = true;
    else delete acc.busy[e.payload.key];
  }).catch(() => {});
}

// ---------- 자동 전환 ----------

/**
 * 탭(또는 레인) 하나가 쓰는 계정. 시작 때 `pick`, 한도로 실패하면 `next`로 다음 계정.
 * `next`는 바꿀 계정이 없으면 null.
 */
export function createRotator(cli: Cli) {
  // 화면(사용량 표시)이 따라 바뀌도록 반응형으로 둔다
  const st = $state({ current: null as string | null });
  const find = (id: string | null) => acc.list.find((a) => a.id === id);
  return {
    get id() {
      return st.current;
    },
    /** 이 탭이 쓰는 계정의 한도(계정 카드와 같은 값). 계정을 모르면 null */
    get limits(): Limits | null {
      return toLimits(find(st.current)?.limits);
    },
    get label() {
      return accountLabel(find(st.current));
    },
    async pick(): Promise<string | null> {
      if (!acc.loaded) await loadAccounts();
      st.current = await pickAccount(cli);
      if (st.current) acc.using[cli] = st.current;
      return st.current;
    },
    async next(untilS?: number | null): Promise<{ from: string; to: string } | null> {
      if (!multiAccount()) return null; // 배포판: 다른 계정으로 바꾸지 않는다
      if (!acc.loaded) await loadAccounts();
      const prev = st.current;
      if (prev) await exhaustAccount(prev, untilS);
      const n = await pickAccount(cli);
      if (!n || n === prev) return null;
      const n2 = find(n);
      if (n2 && isExhausted(n2)) return null;
      st.current = n;
      acc.using[cli] = n;
      return { from: accountLabel(find(prev)), to: accountLabel(n2) };
    },
    /**
     * 새 지시 직전: 계정 패널에서 다른 계정으로 전환했으면 그 계정으로 바꾼다.
     * 바뀌었으면 {from, to}(Claude는 같은 대화로 재시작해야 함), 그대로면 null.
     */
    async sync(): Promise<{ from: string; to: string } | null> {
      const n = await pickAccount(cli);
      if (!n || n === st.current) return null;
      const prev = st.current;
      st.current = n;
      acc.using[cli] = n;
      return { from: accountLabel(find(prev)), to: accountLabel(find(n)) };
    },
    note(l: Limits | null) {
      if (st.current) void noteLimits(st.current, l);
    },
    /** 이 CLI 계정 중 하나라도 다시 쓸 수 있게 되는 시각(ms), 모르면 null */
    usableAt(): number | null {
      const s = nextUsableAt(acc.list, cli, Date.now() / 1000);
      return s === null ? null : s * 1000;
    },
  };
}
export type Rotator = ReturnType<typeof createRotator>;
