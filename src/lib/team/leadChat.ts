// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀장 대화 기록과 확인 요청(기획·배치·합치기). 확인 요청은 확인하면 실행할 행동을 함께 담아
// 앱을 다시 켜도 대기 중인 배치가 남는다. 나중에 폰으로도 같은 형식으로 보낸다.

import type { LeadAction, LeadPlan, LeadReply } from "./leadAgent";
import type { Member } from "./team";

export interface ConfirmReq {
  id: string;
  /** merge는 3단계(합치기)에서 */
  kind: "plan" | "allocation" | "merge" | "git" | "branch" | "pr" | "other";
  title: string;
  body: string;
  /** 배치표 */
  rows?: { name: string; task: string; change?: string }[];
  files?: string[];
  /** 확인하면 실행할 것 */
  actions?: LeadAction[];
  /** branch: 새로 만들 작업 브랜치 이름 */
  branch?: string;
  /** pr: 올릴 브랜치(누를 때 지금 브랜치와 같아야 올린다)·PR 제목·설명. github가 아니면 push만 */
  pr?: { branch: string; title: string; body: string; github: boolean };
  /** merge: 누르면 원래 폴더에서 고친 것(합칠 내용과 겹치는 것)을 git stash로 보관한 뒤 합친다 */
  stash?: boolean;
  /** 이 카드만의 버튼 글(없으면 kind대로) */
  buttons?: [string, string];
  /** 이 확인이 걸린 사용자 지시(앱을 다시 켜도 확인하면 그 지시로 실행) */
  instruction?: string;
  state: "open" | "ok" | "revise" | "dropped";
}

export interface ChatMsg {
  key: string;
  role: "user" | "lead" | "note";
  text: string;
  at: number;
  confirm?: ConfirmReq;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** 배치표: 맡길 일마다 한 줄(새로 만듦·역할 바꿈 표시), 맡긴 일 없이 만들거나 바꾸기만 한 에이전트도 한 줄 */
export function allocationRows(plan: LeadPlan, members: Member[]): NonNullable<ConfirmReq["rows"]> {
  const roleNames = plan.roles.map((r) => members.find((m) => m.id === r.id)?.name ?? "");
  const change = (name: string) =>
    plan.creates.some((c) => sameName(c.name, name)) ? "새로 만듦" : roleNames.some((n) => sameName(n, name)) ? "역할 바꿈" : undefined;
  const rows = plan.assign.map((a) => {
    const c = change(a.name);
    return c ? { name: a.name, task: a.task, change: c } : { name: a.name, task: a.task };
  });
  for (const n of [...plan.creates.map((c) => c.name), ...roleNames]) {
    if (n && !rows.some((r) => sameName(r.name, n))) rows.push({ name: n, task: "(이번에 맡긴 일 없음)", change: change(n)! });
  }
  return rows;
}

export function confirmFrom(reply: LeadReply, plan: LeadPlan, members: Member[], kind: ConfirmReq["kind"], id: string): ConfirmReq {
  const title = reply.confirm?.title || (kind === "plan" ? "기획 확인" : kind === "allocation" ? "배치 확인" : "확인 요청");
  const files = reply.confirm?.files;
  return {
    id,
    kind,
    title,
    body: reply.confirm?.body || (kind === "plan" ? reply.say : [reply.purpose && `목적: ${reply.purpose}`, reply.scope && `범위: ${reply.scope}`].filter(Boolean).join("\n")),
    ...(plan.assign.length || plan.creates.length || plan.roles.length ? { rows: allocationRows(plan, members) } : {}),
    ...(files?.length ? { files } : {}),
    actions: reply.actions,
    state: "open",
  };
}

/** 가장 최근의 열린 확인 요청 */
export function openConfirm(msgs: ChatMsg[]): ConfirmReq | null {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].confirm?.state === "open") return msgs[i].confirm!;
  return null;
}

/** 확인 카드의 갈래 — 팀장 제안(기획·배치·기타)은 서로 대신하고, 합치기·올리기 등은 같은 종류끼리만 */
const family = (k: ConfirmReq["kind"]) => (k === "plan" || k === "allocation" || k === "other" ? "lead" : k);

/** 새 확인 카드를 띄우기 전에: 같은 갈래의 열린 카드는 닫는다(최신 카드가 그 결정을 대신한다). 닫은 수 */
export function supersede(msgs: ChatMsg[], kind: ConfirmReq["kind"]): number {
  let n = 0;
  for (const m of msgs)
    if (m.confirm?.state === "open" && family(m.confirm.kind) === family(kind)) {
      m.confirm.state = "dropped";
      n++;
    }
  return n;
}

/** 폴더 + 팀(team: 그 팀의 대화 기록 id) — 같은 폴더의 팀 탭끼리 기록이 섞이지 않게 */
export const chatKey = (dir: string, team = "") => `aith.leadchat:${dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}${team ? `#${team}` : ""}`;

const KEEP = 200;

export function loadChat(storage: Pick<Storage, "getItem"> | undefined, dir: string, team = ""): ChatMsg[] {
  try {
    const v = JSON.parse(storage?.getItem(chatKey(dir, team)) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveChat(storage: Pick<Storage, "setItem"> | undefined, dir: string, msgs: ChatMsg[], team = ""): void {
  try {
    storage?.setItem(chatKey(dir, team), JSON.stringify(msgs.slice(-KEEP)));
  } catch {
    // 저장 실패는 무시
  }
}

/** 카드 종류마다 [확인, 거절] 버튼 글자 */
export const CONFIRM_BUTTONS: Record<ConfirmReq["kind"], [string, string]> = {
  plan: ["확인하고 진행", "고칠래요"],
  allocation: ["확인하고 진행", "고칠래요"],
  other: ["확인하고 진행", "고칠래요"],
  merge: ["합치기", "나중에"],
  git: ["git 저장소 만들기", "같은 폴더에서 일하기"],
  branch: ["새 브랜치 만들어 합치기", "나중에"],
  pr: ["push하고 PR 올리기", "나중에"],
};

/** 공유 저장소에서 합칠 작업 브랜치 이름(기본 브랜치에 바로 합치지 않게) — 앱 이름은 넣지 않는다 */
export function proposeBranch(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `feature/team-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** 남의 저장소인데 지금 브랜치가 기본 브랜치(master 등): 작업 브랜치를 만들어 거기에 합칠지 */
export function branchConfirm(id: string, current: string, proposed: string, repo: string): ConfirmReq {
  return {
    id,
    kind: "branch",
    title: "작업 브랜치 만들기",
    body: `지금 브랜치가 ${current}예요. 남의 저장소(${repo})라 ${current}에 바로 합치지 않고 ${proposed} 브랜치를 새로 만들어 거기에 합칠게요.`,
    branch: proposed,
    state: "open",
  };
}

/** 합친 뒤 올리기: push하고 PR(제목·설명을 카드에 보여 주고 누를 때만) */
export function prConfirm(id: string, o: { branch: string; base: string; repo: string; fork: boolean; title: string; body: string; github?: boolean }): ConfirmReq {
  const github = o.github !== false;
  const where = `${o.branch} → ${o.base || "기본 브랜치"} (${o.repo})${o.fork ? " · 쓰기 권한이 없어 내 계정에 fork를 만들어 올려요" : ""}`;
  return {
    id,
    kind: "pr",
    title: github ? "올리고 PR 만들기" : "올리기(push)",
    body: `${where}\n\n제목: ${o.title}${o.body ? `\n\n${o.body}` : ""}\n\n${github ? "이미 이 브랜치의 PR이 열려 있으면 push만으로 그 PR에 반영돼요." : "GitHub 저장소가 아니라 push만 해요 — PR(병합 요청)은 그 사이트에서 직접 만들어 주세요."}`,
    pr: { branch: o.branch, title: o.title, body: o.body, github },
    ...(github ? {} : { buttons: ["push하기", "나중에"] as [string, string] }),
    state: "open",
  };
}

/** 합치기 확인(dirty: 원래 폴더에 직접 고친 게 있어 기다림) */
/** dirtyFiles: 기다리게 만든, 원래 폴더에서 직접 고친 파일들(카드에 보여 준다) */
export function mergeConfirm(id: string, rows: { name: string; stat: string }[], dirty: boolean, dirtyFiles: string[] = []): ConfirmReq {
  return {
    id,
    kind: "merge",
    title: dirty ? "합치기 대기" : "합치기 확인",
    body: dirty
      ? `원래 폴더에서 직접 고친 파일${dirtyFiles.length ? ` ${dirtyFiles.length}개` : ""}가 합칠 내용과 겹쳐서 기다릴게요. '보관하고 합치기'를 누르면 원래 폴더에서 고친 것을 git stash에 보관한 뒤 합쳐요(지우지 않아요 — 되돌리려면 git stash pop). 직접 커밋하거나 정리했으면 그래도 이 버튼을 누르면 돼요.`
      : "에이전트들이 각자 브랜치에서 한 일을 지금 브랜치에 합칠게요.",
    ...(dirty ? { stash: true, buttons: ["보관하고 합치기", "나중에"] as [string, string] } : {}),
    ...(rows.length ? { rows: rows.map((r) => ({ name: r.name, task: r.stat })) } : {}),
    ...(dirtyFiles.length ? { files: dirtyFiles.slice(0, 12) } : {}),
    state: "open",
  };
}

/** git 저장소가 아닌 폴더: 만들지, 같은 폴더에서 일할지 — 확인하면 미뤄 둔 배치를 실행 */
export function gitConfirm(id: string, actions: LeadAction[], instruction: string): ConfirmReq {
  return {
    id,
    kind: "git",
    title: "git 저장소 만들기",
    body: "에이전트마다 자기 브랜치에서 일하려면 이 폴더가 git 저장소여야 해요. 만들까요? (프로젝트 종류에 맞는 무시 목록을 넣고 첫 커밋을 해요)",
    actions,
    instruction,
    state: "open",
  };
}
