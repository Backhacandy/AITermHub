// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 탭(세션) 상태 스토어 — Svelte 5 runes
import type { Member, Kickoff } from "$lib/team/team";
import { leadMember } from "$lib/team/leadAgent";
import { MODES, modelForMode } from "$lib/team/mode";
import { settings } from "$lib/settings.svelte";
export type Preset = "claude" | "codex" | "powershell" | "cli";
export type Role = "plan" | "build" | "review" | null;
export type Kind = "term" | "agent" | "claude" | "codex" | "pair" | "company" | "compare" | "preview";

export interface TabInfo {
  id: string;
  title: string;
  preset: Preset;
  program: string;
  args: string[];
  cwd?: string;
  model?: string;
  /** 생각 깊이(Claude·Codex 단일 탭, 비었으면 설정 파일 값) */
  effort?: string;
  role?: Role;
  kind: Kind;
  permission?: string;
  sandbox?: string;
  approval?: string;
  cont?: boolean;
  bare?: boolean;
  /** 구조화 세션의 대화 id(Claude 세션 id / Codex thread id) — 앱을 다시 켤 때 정확히 이어가기용 */
  resume?: string;
  /** 2인 협업 탭의 Codex thread id(resume은 Claude 세션 id) */
  resume2?: string;
  /** 2인 협업 탭의 레인별 모델 설정("auto" 또는 모델 id) — 옛 협업 탭에서 팀으로 이어받을 때만 쓴다 */
  models?: { claude?: string; codex?: string };
  /** 팀 탭(kind "pair")의 에이전트 구성. 없으면 옛 협업 탭 → 두 에이전트 */
  team?: Member[];
  /** 팀 탭을 열면 이 목적·첫 작업으로 바로 시작(한 번만 — 시작하면 지운다) */
  kickoff?: Kickoff;
  /** 팀 탭을 열면 에이전트 추가 창부터(단일 탭에서 "＋ 에이전트"로 바꿨을 때, 한 번만) */
  addOpen?: boolean;
  /** 터미널 탭 추가 환경변수(계정 로그인 탭) */
  env?: [string, string][];
  /** 저장하지 않는 임시 탭(앱을 다시 켜면 복원 안 함) */
  transient?: boolean;
  /** 다른 CLI 에이전트 탭(agents/registry의 id) */
  agent?: string;
  /** 웹 미리보기 탭의 주소 */
  url?: string;
}

export function presetSpec(preset: Preset): { title: string; program: string; args: string[] } {
  switch (preset) {
    case "claude":
      return { title: "Claude", program: "cmd.exe", args: ["/k", "claude"] };
    case "codex":
      return { title: "Codex", program: "cmd.exe", args: ["/k", "codex"] };
    default:
      return { title: "PowerShell", program: "powershell.exe", args: [] };
  }
}

export const ROLE_LABELS: Record<string, string> = {
  plan: "설계",
  build: "구현",
  review: "리뷰",
};

let counter = 0;

export const tabs = $state<TabInfo[]>([]);
export const active = $state<{ id: string | null }>({ id: null });

export function addTab(preset: Preset, cwd?: string): string {
  const spec = presetSpec(preset);
  return addSession({ title: spec.title, preset, program: spec.program, args: spec.args, cwd });
}

export function addSession(opts: {
  title: string;
  preset: Preset;
  program: string;
  args: string[];
  cwd?: string;
  model?: string;
  effort?: string;
  role?: Role;
  kind?: Kind;
  permission?: string;
  sandbox?: string;
  approval?: string;
  cont?: boolean;
  bare?: boolean;
  resume?: string;
  resume2?: string;
  models?: { claude?: string; codex?: string };
  team?: Member[];
  kickoff?: Kickoff;
  addOpen?: boolean;
  env?: [string, string][];
  transient?: boolean;
  agent?: string;
  url?: string;
}): string {
  const id = `t${++counter}-${Date.now()}`;
  tabs.push({ id, role: null, kind: "term", ...opts });
  active.id = id;
  return id;
}

/** 탭 제목: "이름 · 폴더" */
function titled(name: string, cwd?: string): string {
  const base = cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base ? `${name} · ${base}` : name;
}

// Codex 구조화 세션(codex exec --json, 턴마다 one-shot + resume)
export function addCodex(cwd?: string, model?: string, sandbox = "workspace-write", approval = "on-request", cont = false, effort?: string): string {
  return addSession({
    title: titled("Codex", cwd),
    preset: "codex",
    program: "",
    args: [],
    cwd,
    model,
    sandbox,
    approval,
    cont,
    effort,
    kind: "codex",
  });
}

// Claude 구조화 세션(stream-json, 대화/작업현황 분리)
export function addClaude(cwd?: string, model?: string, permission = "acceptEdits", cont = false, bare = false, effort?: string): string {
  return addSession({
    title: titled("Claude", cwd),
    preset: "claude",
    program: "",
    args: [],
    cwd,
    model,
    permission,
    cont,
    bare,
    effort,
    kind: "claude",
  });
}

// 🤝 Claude + Codex 2인 협업(같은 폴더, 지난 기억 이어받기, 명령 하나를 역할대로 나눔)
/** 웹 미리보기(이 PC의 개발 서버) */
export function addPreview(cwd: string): string {
  return addSession({ title: titled("미리보기", cwd), preset: "powershell", program: "", args: [], cwd, kind: "preview" });
}

/** 다른 CLI 에이전트(Gemini 등)를 그 폴더에서 터미널 탭으로 */
export function addCliAgent(a: { id: string; name: string }, args: string[], cwd: string): string {
  return addSession({ title: titled(a.name, cwd), preset: "cli", program: "cmd.exe", args, cwd, agent: a.id });
}

/** 설치 명령을 PowerShell 탭에서 실행(임시 탭) */
export function addInstallTab(name: string, command: string): string {
  return addSession({ title: `${name} 설치`, preset: "powershell", program: "powershell.exe", args: ["-NoExit", "-Command", command], transient: true });
}

/** 비교: 같은 지시를 Claude·Codex가 각자 작업 공간에서 → 골라서 합치기 */
export function addCompare(cwd: string): string {
  return addSession({ title: titled("비교", cwd), preset: "claude", program: "", args: [], cwd, kind: "compare" });
}

export function addPair(cwd: string): string {
  return addSession({ title: titled("팀", cwd), preset: "claude", program: "", args: [], cwd, kind: "pair" });
}

/** 새 세션 창에서 에이전트 여러 명으로 시작: 정한 에이전트 구성 그대로 팀 탭 */
export function addTeam(cwd: string, team: Member[], kickoff?: Kickoff | null, title?: string): string {
  return addSession({ title: title ?? titled("팀", cwd), preset: team[0]?.cli ?? "claude", program: "", args: [], cwd, kind: "pair", team, ...(kickoff ? { kickoff } : {}) });
}

/**
 * Claude·Codex 탭에서 "＋ 에이전트": 같은 폴더의 팀 탭으로 바꾼다. 지금 대화·모델은 첫 에이전트가 이어받고,
 * 원래 탭은 닫고, 팀 탭은 에이전트 추가 창부터 연다. 그 밖의 탭이면 null.
 */
export function toTeam(tabId: string): string | null {
  const t = tabs.find((x) => x.id === tabId);
  if (!t || (t.kind !== "claude" && t.kind !== "codex")) return null;
  const cli = t.kind;
  // 새 팀은 설정의 기본 운영 방식(기본 라이트)으로 — 맥스는 나중에 바꿀 수 있지만 맥스 팀은 라이트로 돌아가지 않는다
  const md = settings.defaultMode ?? "lite";
  const p = MODES[md];
  const first: Member = {
    id: "m1",
    name: cli === "claude" ? "Claude" : "Codex",
    cli,
    ...modelForMode(cli, t.model || "auto", undefined, p.maxTier),
    purpose: "",
    areas: [],
    ...(t.resume ? { resume: t.resume } : {}),
    ...(t.effort ? { effort: t.effort } : {}),
  };
  const lead: Member = { ...leadMember([first]), id: "lead", mode: md, model: p.leadModel, effort: p.leadEffort };
  const id = addSession({ title: titled("팀", t.cwd), preset: cli, program: "", args: [], cwd: t.cwd, kind: "pair", team: [lead, first], addOpen: true });
  closeTab(tabId);
  active.id = id;
  return id;
}

// ---------- 최근 닫은 팀(구성·대화 id·작업 폴더·팀장 기록을 그대로 다시 연다) ----------
export interface ClosedTeam {
  tab: Omit<TabInfo, "id">;
  at: number;
}
const CLOSED_KEY = "aith.closedTeams";
const CLOSED_MAX = 10;
/** 팀 하나를 알아보는 값: 팀장 대화 기록 id(없으면 폴더+제목) */
const teamKeyOf = (t: Omit<TabInfo, "id">) => t.team?.find((m) => m.lead)?.chat ?? `${t.cwd ?? ""}|${t.title}`;

/** 닫은 탭을 목록에 더한다(팀 탭만, 같은 팀은 하나로 최근 것이 앞, 10개까지) */
export function rememberClosed(list: ClosedTeam[], tab: Omit<TabInfo, "id">, now: number): ClosedTeam[] {
  if (tab.kind !== "pair" || !tab.team?.length) return list;
  const key = teamKeyOf(tab);
  return [{ tab, at: now }, ...list.filter((c) => teamKeyOf(c.tab) !== key)].slice(0, CLOSED_MAX);
}

export function closedTeams(): ClosedTeam[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveClosed(list: ClosedTeam[]) {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(list));
  } catch {
    // 저장 실패는 무시
  }
}

/** 최근 닫은 팀 i번째를 다시 연다(목록에서 뺀다). 새 탭 id */
export function reopenTeam(i: number): string | null {
  const list = closedTeams();
  const c = list[i];
  if (!c) return null;
  saveClosed(list.filter((_, j) => j !== i));
  const id = addSession({ ...c.tab, kickoff: undefined, addOpen: false });
  active.id = id;
  return id;
}

export function closeTab(id: string) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const { id: _id, ...rest } = $state.snapshot(tabs[i]) as TabInfo;
  if (rest.kind === "pair" && !rest.transient) saveClosed(rememberClosed(closedTeams(), rest, Date.now()));
  tabs.splice(i, 1);
  if (active.id === id) {
    active.id = tabs[Math.min(i, tabs.length - 1)]?.id ?? null;
  }
}

export function setRole(id: string, role: Role) {
  const t = tabs.find((x) => x.id === id);
  if (t) t.role = role;
}

// ---- 앱을 다시 켤 때 탭 복원 ----
// 앱을 끄면 프로세스는 정리되지만(메모리 절약), 열려 있던 탭 구성은 저장해 두었다가
// 다시 켤 때 같은 폴더·설정으로 열고 대화는 "이어서"로 복원한다.

const TABS_KEY = "aith.tabs";

type SavedTab = Omit<TabInfo, "id">;

/** 터미널 탭의 CLI 인자를 "이어서"로 바꾼다(claude -c / codex resume --last). */
export function continueArgs(preset: Preset, args: string[]): string[] {
  const i = args.findIndex((a) => a === preset);
  if (i < 0) return args;
  const head = args.slice(0, i + 1);
  let rest = args.slice(i + 1);
  if (preset === "claude") {
    if (rest.some((a) => a === "-c" || a === "--continue")) return args;
    rest = rest.filter((a) => a !== "-r" && a !== "--resume"); // 세션 선택 화면 대신 최근 대화로
    return [...head, "-c", ...rest];
  }
  if (preset === "codex") {
    if (rest[0] === "resume") rest = rest.slice(1).filter((a) => a !== "--last");
    return [...head, "resume", "--last", ...rest];
  }
  return args;
}

/** continueArgs의 반대: 이 폴더에 이어 갈 대화가 없을 때(-c면 CLI가 "No conversation found"로 바로 끝난다) 새 대화로 */
export function withoutContinue(preset: Preset, args: string[]): string[] {
  const i = args.findIndex((a) => a === preset);
  if (i < 0) return args;
  const head = args.slice(0, i + 1);
  let rest = args.slice(i + 1);
  if (preset === "claude") rest = rest.filter((a) => a !== "-c" && a !== "--continue");
  else if (preset === "codex" && rest[0] === "resume") rest = rest.slice(1).filter((a) => a !== "--last");
  return [...head, ...rest];
}

export function saveTabs() {
  try {
    const keep = tabs.filter((t) => !t.transient);
    const saved: SavedTab[] = keep.map(({ id: _id, ...rest }) => rest);
    const activeIdx = keep.findIndex((t) => t.id === active.id);
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: saved, active: activeIdx }));
  } catch {
    // 저장 실패는 무시
  }
}

/** 저장된 탭을 다시 연다. 복원한 탭이 있으면 true. */
/** 예전 이름으로 저장된 탭 제목 → 지금 이름(여러 에이전트 = "팀 · 폴더", AI 회사 = "자동 진행"). 직접 바꾼 제목은 그대로 */
export function renamedTitle(t: { kind: string; title: string; cwd?: string }): string {
  if (t.kind === "pair" && /^(🤝\s*)?협업(\s*·.*)?$/.test(t.title.trim())) return titled("팀", t.cwd);
  if (t.kind === "company" && t.title.trim() === "AI 회사") return "자동 진행";
  return t.title;
}

export function restoreTabs(): boolean {
  let data: { tabs: SavedTab[]; active: number } | null = null;
  try {
    data = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
  } catch {
    data = null;
  }
  if (!data?.tabs?.length) return false;
  const ids: string[] = [];
  for (const t of data.tabs) {
    const restored: SavedTab = { ...t, title: renamedTitle(t) };
    if (t.kind === "claude" || t.kind === "codex") restored.cont = true;
    else if (t.kind === "term") restored.args = continueArgs(t.preset, t.args);
    ids.push(addSession(restored));
  }
  active.id = ids[data.active] ?? ids[ids.length - 1] ?? null;
  return true;
}
