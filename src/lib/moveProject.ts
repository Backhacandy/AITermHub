// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 프로젝트 경로 바꾸기: 사용자가 옮긴 프로젝트 폴더를 탭이 새 경로로 쓰게 한다.
// 에이전트 기억(Claude 대화 기록)은 새 경로 쪽으로 복사하고(project_move), 팀장 대화·역할·설정처럼 경로로 찾는 것도 새 경로로 옮긴다.
// 탭은 cwd가 바뀌면 화면을 새로 띄워(+page의 {#key}) 같은 대화 id로 새 경로에서 이어 간다.
import { invoke } from "@tauri-apps/api/core";
import type { TabInfo } from "./sessions.svelte";
import type { Member } from "./team/team";
import { loadChat, saveChat } from "./team/leadChat";
import { settings, saveSettings } from "./settings.svelte";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** 경로 비교용 키(대소문자·구분자 무시) */
export const pathKey = (p: string) => norm(p).toLowerCase();

/** from 아래 경로면 to 아래로 바꾼 경로, 아니면 null(구분자는 to를 따른다) */
export function rebase(p: string, from: string, to: string): string | null {
  const a = norm(p);
  const f = norm(from);
  const base = to.replace(/[\\/]+$/, "");
  if (a.toLowerCase() === f.toLowerCase()) return base;
  if (!a.toLowerCase().startsWith(`${f.toLowerCase()}/`)) return null;
  const sep = base.includes("\\") ? "\\" : "/";
  return base + sep + a.slice(f.length + 1).split("/").join(sep);
}

/** 제목 끝의 " · 옛 폴더 이름"을 새 폴더 이름으로(직접 바꾼 제목이면 그대로) */
export function retitle(title: string, from: string, to: string): string {
  const name = (p: string) => norm(p).split("/").pop() ?? "";
  const suffix = ` · ${name(from)}`;
  return title.endsWith(suffix) ? `${title.slice(0, -suffix.length)} · ${name(to)}` : title;
}

/** 팀 에이전트 작업 폴더 옮기기 계획: 바뀐 구성과 (옛 작업 폴더, 새 작업 폴더) */
export function planTeam(team: Member[] | undefined, from: string, to: string): { team?: Member[]; worktrees: [string, string][] } {
  if (!team) return { worktrees: [] };
  const worktrees: [string, string][] = [];
  const next = team.map((m) => {
    if (!m.wt) return m;
    const wt = rebase(m.wt, from, to);
    // 프로젝트 밖에 있던 작업 폴더는 그대로(옮겨지지 않았다)
    if (!wt) return m;
    worktrees.push([m.wt, wt]);
    return { ...m, wt };
  });
  return { team: next, worktrees };
}

/** 값 목록에서 옛 경로를 새 경로로 */
function swapList(list: string[] | undefined, from: string, to: string): string[] | undefined {
  return list?.map((d) => (pathKey(d) === pathKey(from) ? to : d));
}

/** 경로로 찾는 localStorage·설정 값을 새 경로로 옮긴다(새 경로에 이미 있으면 그대로) */
function moveKeys(t: TabInfo, from: string, to: string) {
  const ls = typeof localStorage === "undefined" ? undefined : localStorage;
  // 팀장 대화
  const chatId = t.team?.find((m) => m.lead)?.chat;
  if (chatId && ls && !loadChat(ls, to, chatId).length) {
    const old = loadChat(ls, from, chatId);
    if (old.length) saveChat(ls, to, old, chatId);
  }
  // 옛 협업 탭 역할
  try {
    const rk = (d: string) => `aith.pair.roles:${pathKey(d)}`;
    const v = ls?.getItem(rk(from));
    if (v && !ls?.getItem(rk(to))) ls?.setItem(rk(to), v);
    const gk = "aith.grass.last";
    const last = JSON.parse(ls?.getItem(gk) ?? "{}") as Record<string, number>;
    const hit = Object.keys(last).find((d) => pathKey(d) === pathKey(from));
    if (hit && last[to] === undefined) {
      last[to] = last[hit];
      ls?.setItem(gk, JSON.stringify(last));
    }
  } catch {
    // 저장소를 못 쓰면 건너뛴다
  }
  // 설정: 영역·잔디·원격·포트폴리오·마지막 폴더
  const fk = pathKey(from);
  const tk = pathKey(to);
  if (settings.pairAreas?.[fk] && !settings.pairAreas[tk]) settings.pairAreas = { ...settings.pairAreas, [tk]: settings.pairAreas[fk] };
  if (settings.portfolio?.[fk] && !settings.portfolio[tk]) settings.portfolio = { ...settings.portfolio, [tk]: settings.portfolio[fk] };
  settings.grassDirs = swapList(settings.grassDirs, from, to);
  settings.remoteDirs = swapList(settings.remoteDirs, from, to);
  if (settings.lastCwd && pathKey(settings.lastCwd) === fk) settings.lastCwd = to;
}

export interface MoveResult {
  copied: number;
  /** 새 경로에 없던 에이전트 작업 폴더(그 에이전트는 새 프로젝트 폴더에서 이어 간다) */
  missing: string[];
  repaired: boolean;
}

/** 탭의 프로젝트 경로를 to로 바꾼다. 에이전트 기억을 먼저 옮기고, 그다음 탭을 바꿔 화면을 새로 띄운다 */
export async function moveProject(t: TabInfo, to: string): Promise<MoveResult> {
  const from = t.cwd;
  if (!from) throw new Error("이 탭에는 프로젝트 폴더가 없어요");
  if (pathKey(from) === pathKey(to)) throw new Error("지금과 같은 폴더예요");
  const r = await invoke<MoveResult>("project_move", { from, to, worktrees: planTeam(t.team, from, to).worktrees });
  moveKeys(t, from, to);
  // 기다리는 사이 바뀐 구성(대화 id 등)을 놓치지 않게 지금 구성으로 다시 계산한다
  const plan = planTeam(t.team, from, to);
  if (plan.team) {
    // 새 경로에 없는 작업 폴더는 비운다(그 에이전트 기억은 새 프로젝트 폴더 쪽으로 옮겼다)
    const gone = new Set(r.missing.map(pathKey));
    t.team = plan.team.map((m) => (m.wt && gone.has(pathKey(m.wt)) ? { ...m, wt: undefined } : m));
  }
  t.title = retitle(t.title, from, to);
  // 마지막에 바꾼다 — 화면이 새 경로로 다시 뜨면서 같은 대화 id로 이어 간다
  t.cwd = to;
  await saveSettings();
  return r;
}
