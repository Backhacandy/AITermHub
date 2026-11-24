// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 탭(에이전트 N개): 구성원·@이름 라우팅·에이전트별 프롬프트·인계 메모 나누기·영역 침범·동시 실행 상한. 모두 토큰 0, 로컬 규칙.

import { ROLE_LABEL, extractHandoff, mentionOf, roleSwitch, type Agent, type Areas, type Role, type Roles } from "$lib/pair/route";
import { CODEX_PATCH_RULE } from "$lib/work/codexRules";
import { matchOwns } from "$lib/collab/ownership";
import { MODELS } from "$lib/collab/catalog";

export interface Member {
  /** 에이전트 id — 프로세스 id(`${tabId}~${id}`)에 쓰인다. 옛 협업 탭에서 이어받은 에이전트는 "codex"/"claude" */
  id: string;
  /** @이름으로 부르는 짧은 이름 */
  name: string;
  cli: "claude" | "codex";
  /** "auto" 또는 모델 id */
  model: string;
  /** 맡을 일 */
  purpose: string;
  /** 담당 경로(글롭). 비어 있으면 맡을 일로만 나눈다 */
  areas: string[];
  /** 이어 갈 대화 id(Claude 세션 / Codex thread) */
  resume?: string;
  /** 추가한 에이전트: 사용자 MCP 서버를 불러오지 않는다 */
  lean?: boolean;
  /** 생각 깊이(비었으면 CLI 설정 파일 값) */
  effort?: string;
  /** 브리핑 담당(옛 팀): 일은 나눠 받지 않고, 지시가 끝날 때마다 결과만 정리해 알려 준다 — 팀장이 생기면 빠진다 */
  brief?: boolean;
  /** 팀장: 사용자와 대화하고 배치·역할 조정·확인 요청·보고를 맡는다(코드는 고치지 않음) */
  lead?: boolean;
  /** 팀장 메모(사용자가 배치를 고친 내용 등 — 다음 배치부터 반영) */
  notes?: string[];
  /** 팀장: 이 팀의 대화 기록 id(같은 폴더의 팀 탭끼리 기록이 섞이지 않게) — 브랜치 이름에도 쓴다 */
  chat?: string;
  /** 원래 폴더에서 일함(브랜치 없이 — 엔진 프로젝트의 플레이 테스트 담당 등) */
  home?: boolean;
  /** 이 에이전트의 작업 폴더(자기 브랜치 워크트리) */
  wt?: string;
  /** 라이트로 바꾸며 낮추기 전 모델(맥스로 돌아오면 되돌린다) */
  maxModel?: string;
  /** 팀장: 예전에 라이트로 낮아진 모델을 대화 기록에서 찾아 되돌리는 일을 이미 했는지(한 번만) */
  modelsRecovered?: boolean;
  /** 팀장: 합치기 전에 물어볼지(기본 물어봄) */
  mergeAsk?: boolean;
  /** 팀장: git 저장소를 만들지 않기로 해 같은 폴더에서 일함 */
  branchOff?: boolean;
  /** 팀장: 운영 방식(없으면 옛 팀 = 맥스) */
  mode?: "lite" | "max";
  /** 브라우저(Claude in Chrome)를 쓰는 역할(맥스에서만) */
  chrome?: boolean;
  /** 팀장: 밤새 모드(이 시각까지 확인 카드 자동 승인·합치기 바로·후속 무제한) */
  night?: { until: number; fails: Record<string, number> };
}

/** 일을 나눠 받는 에이전트인지(브리핑 담당·팀장은 아님) */
export const isWorker = (m: { brief?: boolean; lead?: boolean }) => !m.brief && !m.lead;

/** 옛 협업 탭(Claude 1 + Codex 1) → 두 에이전트(백엔드 에이전트 먼저). 대화 id·모델·영역을 그대로 */
export function fromPair(tab: { resume?: string; resume2?: string; models?: { claude?: string; codex?: string } }, roles: Roles, areas: Areas): Member[] {
  const one = (a: Agent, role: Role): Member => {
    const resume = a === "claude" ? tab.resume : tab.resume2;
    return {
      id: a,
      name: a === "claude" ? "Claude" : "Codex",
      cli: a,
      model: tab.models?.[a] ?? "auto",
      purpose: ROLE_LABEL[role],
      areas: areas[role],
      ...(resume ? { resume } : {}),
    };
  };
  return [one(roles.back, "back"), one(roles.front, "front")];
}

/** @단어 → 에이전트. 에이전트 이름(정확히, 또는 두 글자 이상 앞부분)이 먼저, 그다음 옛 호출어(@cl/@co → 그 CLI의 첫 에이전트) */
function memberOf(word: string, members: Member[]): Member | null {
  const w = word.toLowerCase();
  // 이름을 "@테스트"처럼 @까지 붙여 지은 에이전트도 @테스트로 부를 수 있게 앞의 @는 빼고 비교
  const nm = (m: Member) => m.name.toLowerCase().replace(/^@+/, "");
  const exact = members.find((m) => nm(m) === w);
  if (exact) return exact;
  if (w.length >= 2) {
    const pre = members.find((m) => nm(m).startsWith(w));
    if (pre) return pre;
  }
  const cli = mentionOf(word);
  return cli ? (members.find((m) => m.cli === cli) ?? null) : null;
}

/** 지시에서 @이름을 떼어 내고 받을 에이전트 id들(없으면 빈 배열) */
export function routeTeam(raw: string, members: Member[]): { ids: string[]; text: string } {
  const ids: string[] = [];
  const text = raw
    .replace(/(^|\s)@([^\s,.!?:@]+)(?=\s|$|[,.!?:])/g, (all, pre: string, word: string) => {
      const m = memberOf(word, members);
      if (!m) return all;
      if (!ids.includes(m.id)) ids.push(m.id);
      return pre;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { ids, text };
}

/** 다른 일하는 에이전트들(브리핑 담당은 영역도 요청 대상도 아니라 뺀다) */
const others = (me: Member, members: Member[]) => members.filter((m) => m.id !== me.id && isWorker(m));
const areaText = (m: Member) => m.areas.join(", ") || "영역 미지정";

/** 에이전트 전체 안내(그 대화에 처음 보낼 때, 이름·영역이 바뀌었을 때, 압축 뒤에만) */
export function teamIntro(me: Member, members: Member[], changed = false): string {
  const rest = others(me, members)
    .map((o) => `  - ${o.name}${o.purpose ? ` · ${o.purpose}` : ""}: ${areaText(o)}`)
    .join("\n");
  return `[팀 협업] 너는 "${me.name}" 담당이다${me.purpose ? ` — ${me.purpose}` : ""}.
- 내 영역(우선): ${me.areas.join(", ") || "지정 없음 — 맡은 일에 필요한 파일만"}
- 다른 에이전트(그 영역은 수정 금지 — 필요하면 인계에 "요청: @이름 …"으로 적기):
${rest || "  - 없음"}${me.cli === "codex" ? `\n- ${CODEX_PATCH_RULE}` : ""}
${changed ? "- 역할·담당이 바뀌었다. 앞서 받은 팀 안내 대신 이 안내를 따른다.\n" : ""}- 이 안내는 대화 처음에 한 번만 온다. 이후 지시에도 계속 지켜라.`;
}

/** 에이전트 구성이 같은지 비교하는 키(바뀌면 전체 안내를 다시 보낸다) */
export const teamKey = (members: Member[]) => JSON.stringify(members.map((m) => [m.id, m.name, m.purpose, m.areas]));

/**
 * 에이전트에게 보낼 지시. full이면 전체 안내를 앞에 붙이고, 아니면 "다른 에이전트 영역 수정 금지" 한 줄만.
 * task: 분배 담당이 나눠 준 내 몫(원래 지시와 다를 때). together: 다른 에이전트도 동시에 일하는지.
 */
/** quiet: 브리핑 담당이 결과를 정리하는 팀 지시 — 사용자에게 보고·요약하지 말고 인계만(출력 토큰·대화 기록을 줄인다) */
export function teamPrompt(o: { me: Member; members: Member[]; instruction: string; task?: string; memo?: string; together: boolean; full: boolean; changed?: boolean; quiet?: boolean }): string {
  const rest = others(o.me, o.members);
  const short = !o.full;
  const together = !o.together
    ? ""
    : short
      ? `- 다른 에이전트도 동시에 작업 중 — 내 몫만. 다른 에이전트가 맡은 결과물은 대역·가짜·복제본도 만들지 말고, 그게 있어야 하면 인계에 "요청: @이름 …". 내 몫이 없으면 파일을 열지 말고 "내 몫 없음" 한 줄로 끝.\n`
      : `- 다른 에이전트도 동시에 작업한다. 내 몫만 하라.\n- 다른 에이전트가 맡은 결과물은 만들지 마라(가짜·대역·임시 복제본 포함). 그 결과가 있어야 하는 부분은 인계에 "요청: @이름 …"으로 남기고, 지금 할 수 있는 부분만 하라. 맞춰야 할 형식(함수·API·데이터)은 인계에 적어라.\n- 이 지시에 내 몫이 없으면 파일을 열어 보지 말고 "내 몫 없음" 한 줄로 바로 끝내라.\n`;
  // 사용자가 범위를 정했으면(기획만·분석까지만·아직 개발하지 마) 나눠 받은 몫이 그보다 넓어도 범위까지만
  const scope = short
    ? `- 범위 제한(~만·~까지만·~하지 마)이 있으면 그 범위까지만, 범위 밖 일은 요청 말고 "다음 단계:"로.\n`
    : `- 사용자 지시에 범위 제한(예: 기획만, 분석까지만, 아직 개발하지 마)이 있으면 그 범위를 지켜라. [내 몫]이 그 범위를 넘으면 범위까지만 하라. 범위 밖 일(구현·설치·테스트 등)은 다른 에이전트에게 "요청:"으로 넘기지 말고 인계에 "다음 단계: …"로만 적어 사용자가 정하게 하라.\n`;
  const memo = o.memo ? `\n[다른 에이전트의 인계 메모]\n${o.memo}\n` : "";
  const task = o.task && o.task.trim() !== o.instruction.trim() ? `\n\n[내 몫]\n${o.task}` : "";
  const head = short
    ? `[팀 협업 · ${o.me.name}] 다른 에이전트 영역(${rest.map((m) => `${m.name}: ${areaText(m)}`).join("; ") || "없음"})은 수정 금지.`
    : teamIntro(o.me, o.members, o.changed);
  const tail = o.quiet
    ? short
      ? `(브리핑 담당이 사용자에게 정리한다 — 보고·요약 없이 "### 인계"만: 바뀐 파일·맞출 형식·"요청: @이름 …", 5줄 이내, 없으면 "없음")`
      : `이 팀에는 브리핑 담당이 있어 결과를 사용자에게 정리한다. 사용자에게 보고·요약·설명을 쓰지 마라. 작업이 끝나면 답은 "### 인계" 제목 아래 다른 에이전트가 알아야 할 것(바뀐 파일·API·데이터 형식)과 해 줘야 할 일("요청: @이름 …")만 5줄 이내로 쓴다. 없으면 "없음".`
    : short
    ? `(끝에 "### 인계" 5줄 이내, 다른 에이전트가 할 일은 "요청: @이름 …" 줄로, 없으면 "없음")`
    : `끝나면 답변 맨 끝에 "### 인계" 제목 아래 다른 에이전트가 알아야 할 것(API·데이터 형식·바뀐 파일)을 5줄 이내로 적어라. 다른 에이전트가 해 줘야 할 일은 "요청: @이름 …" 줄로 적어라. 없으면 "없음".`;
  return `${head}
${together}${scope}${memo}
[사용자 지시]
${o.instruction}${task}

${tail}`;
}

const REQ = /^\s*[-*•]?\s*요청\s*[:：]\s*(.*)$/;

/** 인계의 "요청: @이름 …"으로 콕 집힌 에이전트 id들 — 이번 지시에 없던 에이전트도 이걸로 깨운다 */
export function requestedIds(answer: string, from: Member, members: Member[]): string[] {
  const memo = extractHandoff(answer);
  if (!memo) return [];
  const rest = others(from, members);
  const out: string[] = [];
  for (const line of memo.split("\n")) {
    const at = line.match(REQ)?.[1].match(/@([^\s,.!?:]+)/);
    const t = at ? memberOf(at[1], rest) : null;
    if (t && !out.includes(t.id)) out.push(t.id);
  }
  return out;
}

/**
 * 답의 "### 인계"를 받을 에이전트별 메모로 나눈다.
 * "요청: @이름 …"은 그 에이전트에만, 이름 없는 요청과 그 밖의 정보는 다른 모든 에이전트에.
 */
export function memosFrom(answer: string, from: Member, members: Member[]): Record<string, string> {
  const memo = extractHandoff(answer);
  if (!memo || /^없음\.?$/.test(memo.trim())) return {};
  const rest = others(from, members);
  const out: Record<string, string[]> = {};
  const add = (ids: string[], line: string) => ids.forEach((id) => (out[id] ??= []).push(line));
  for (const line of memo.split("\n").filter((l) => l.trim())) {
    const r = line.match(REQ);
    const at = r?.[1].match(/@([^\s,.!?:]+)/);
    const target = at ? memberOf(at[1], rest) : null;
    if (r && target) add([target.id], line.replace(`@${at![1]}`, "").replace(/\s{2,}/g, " "));
    else add(rest.map((m) => m.id), line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n")]));
}

/** 이 에이전트가 고친 파일(저장소 기준 경로) 중 다른 에이전트 영역이고 내 영역은 아닌 것 */
export function trespassTeam(paths: string[], me: Member, members: Member[]): string[] {
  const rest = others(me, members);
  return paths.filter((p) => rest.some((o) => matchOwns(p, o.areas)) && !matchOwns(p, me.areas));
}

/**
 * 작업 중에 보낸 전체 지시를 나눈 결과 → 첫 단계(first, 없으면 전부) 중 일하는 에이전트에는 끼워 넣고, 쉬는 에이전트는 시작한다.
 * 앞 에이전트가 끝나야 하는 몫(later)은 지금 보내지 않는다(끼워 넣으면 기다리지 않고 바로 해 버린다)
 */
export function routeExtra<T extends { id: string }>(assign: T[], isBusy: (id: string) => boolean, first?: string[]): { interject: T[]; start: T[]; later: T[] } {
  const now = first ? assign.filter((a) => first.includes(a.id)) : assign;
  return {
    interject: now.filter((a) => isBusy(a.id)),
    start: now.filter((a) => !isBusy(a.id)),
    later: assign.filter((a) => !now.includes(a)),
  };
}

/** 일하는 에이전트에 끼워 넣을 글: 추가 지시임을 알리고, 나눠 받은 몫이 원래 글과 다르면 함께 */
export function extraText(text: string, task?: string): string {
  const t = text.trim();
  const k = task?.trim();
  return `[추가 지시] ${t}${k && k !== t ? `\n[내 몫] ${k}` : ""}`;
}

/** 동시 실행 상한: 지금 일하는 에이전트 수(busy)를 빼고 남은 자리만큼 먼저, 나머지는 대기 */
export function splitByCap(ids: string[], busy: number, max: number): { now: string[]; later: string[] } {
  const free = Math.max(0, max - busy);
  return { now: ids.slice(0, free), later: ids.slice(free) };
}

/** 이름이 겹치면 숫자를 붙인다(결제 → 결제2) */
export function uniqueName(name: string, members: Member[]): string {
  const taken = new Set(members.map((m) => m.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}${i}`.toLowerCase())) return `${name}${i}`;
}

/**
 * 두 에이전트(서로 다른 CLI) 팀의 "역할 바꿔"·"codex가 프론트" 지시 → 맡을 일·담당 경로를 맞바꾼다.
 * 지금 역할은 에이전트 순서가 아니라 맡을 일("프론트")로 본다. 역할 지시가 아니면 null
 */
export function teamRoleSwitch(raw: string, members: Member[]): { changed: boolean; note: string } | null {
  if (members.length !== 2 || members[0].cli === members[1].cli) return null;
  const fi = members[0].purpose === ROLE_LABEL.front && members[1].purpose !== ROLE_LABEL.front ? 0 : 1;
  const front = members[fi], back = members[1 - fi];
  const sw = roleSwitch(raw, { front: front.cli, back: back.cli });
  if (!sw) return null;
  const changed = sw.front !== front.cli;
  if (changed) {
    [front.purpose, back.purpose] = [back.purpose, front.purpose];
    [front.areas, back.areas] = [back.areas, front.areas];
  }
  return { changed, note: members.map((m) => `${m.name} ${m.purpose}`).join(" · ") };
}

export interface RoleEdit { name: string; purpose: string; areas: string }

/** 역할·담당 창의 수정을 에이전트들에 반영한다(빈 이름은 그대로, 겹치면 숫자). 바뀐 에이전트마다 알림 한 줄 */
export function applyRoleEdits(members: Member[], edits: Record<string, RoleEdit>): string[] {
  const notes: string[] = [];
  for (const m of members) {
    const e = edits[m.id];
    if (!e) continue;
    const before = JSON.stringify([m.name, m.purpose, m.areas]);
    const old = m.name;
    const name = e.name.trim();
    if (name && name !== m.name) m.name = uniqueName(name, members.filter((x) => x !== m));
    m.purpose = e.purpose.trim();
    m.areas = e.areas.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (JSON.stringify([m.name, m.purpose, m.areas]) !== before)
      notes.push(`${old === m.name ? m.name : `${old} → ${m.name}`}${m.purpose ? ` · ${m.purpose}` : ""}`);
  }
  return notes;
}

/** 동시 실행 상한: AI 회사의 "동시 근무 인원"(localStorage aith.hq의 max), 없거나 이상하면 4 */
export function hqMax(storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): number {
  try {
    const n = JSON.parse(storage?.getItem("aith.hq") ?? "{}")?.max;
    return typeof n === "number" && n >= 1 ? Math.floor(n) : 4;
  } catch {
    return 4;
  }
}

/** 새 세션 창의 에이전트 한 줄(에이전트가 되기 전) */
export interface Row { name: string; cli: "claude" | "codex"; model: string; effort?: string; purpose: string; areas: string[]; task?: string }

/** "목적대로 바로 시작": 처음 보낼 공용 지시(목적)와 에이전트 id별 첫 작업 */
export interface Kickoff { goal: string; tasks: Record<string, string> }

/** 줄 순서대로 만든 에이전트들 → 첫 작업이 있는 에이전트만 id별로. 하나도 없으면 null(바로 시작 안 함) */
export function kickoffFrom(goal: string, rows: { task?: string }[], team: { id: string }[]): Kickoff | null {
  const tasks: Record<string, string> = {};
  rows.forEach((r, i) => {
    const t = r.task?.trim();
    if (t && team[i]) tasks[team[i].id] = t;
  });
  return goal.trim() && Object.keys(tasks).length ? { goal: goal.trim(), tasks } : null;
}

const blankRow = (cli: "claude" | "codex"): Row => ({ name: "", cli, model: "auto", purpose: "", areas: [] });

/**
 * 에이전트 수를 바꿀 때 줄 목록: 있던 줄은 그대로, 모자라면 채운다.
 * 1 → 2: 지금 협업처럼 Codex 백엔드 + Claude 프론트(첫 줄의 CLI는 유지). 그 뒤로는 맡을 일 빈 Claude
 */
export function rowsFor(n: number, prev: Row[]): Row[] {
  const rows = prev.slice(0, Math.max(1, n)).map((r) => ({ ...r }));
  if (!rows.length) rows.push(blankRow("claude"));
  while (rows.length < n) {
    if (rows.length === 1 && !rows[0].purpose) {
      const other = rows[0].cli === "claude" ? "codex" : "claude";
      rows[0].purpose = rows[0].cli === "codex" ? ROLE_LABEL.back : ROLE_LABEL.front;
      rows.push({ ...blankRow(other), purpose: other === "codex" ? ROLE_LABEL.back : ROLE_LABEL.front });
    } else rows.push(blankRow("claude"));
  }
  return rows;
}

/**
 * 줄 목록 → 팀 에이전트. 이름이 비면 CLI 이름(겹치면 숫자), 경로가 비고 맡을 일이 프론트·백엔드면 감지한 영역,
 * 첫 에이전트만 사용자 MCP를 불러온다(나머지는 lean — 메모리 절약)
 */
export function buildTeam(rows: Row[], areas: Areas): Member[] {
  const out: Member[] = [];
  rows.forEach((r, i) => {
    const base = r.name.trim() || (r.cli === "claude" ? "Claude" : "Codex");
    const auto = r.purpose === ROLE_LABEL.front ? areas.front : r.purpose === ROLE_LABEL.back ? areas.back : [];
    out.push({
      id: `m${i + 1}`,
      name: uniqueName(base, out),
      cli: r.cli,
      model: r.model || "auto",
      purpose: r.purpose.trim(),
      areas: r.areas.length ? r.areas : auto,
      ...(r.effort ? { effort: r.effort } : {}),
      ...(i > 0 ? { lean: true } : {}),
    });
  });
  return out;
}

/** 새 브리핑 에이전트(id는 붙이는 쪽에서). 요약만 하니 가벼운 모델로 — 에이전트에서 바꿀 수 있다 */
export function briefMember(members: Member[]): Omit<Member, "id"> {
  return {
    name: uniqueName("브리핑", members),
    cli: "claude",
    model: "haiku",
    purpose: "결과 브리핑(일은 하지 않음)",
    areas: [],
    lean: true,
    brief: true,
  };
}

const BRIEF_RULE =
  "[브리핑 담당] 너는 이 팀의 결과를 사용자에게 짧게 브리핑한다. 파일은 절대 고치지 않는다(필요하면 읽기·git status/diff 확인만). " +
  "에이전트들이 한 말을 그대로 옮기지 말고, 사용자가 지금 무엇을 해 볼 수 있는지 중심으로 정리한다. 지난 브리핑과 이어지게 전체 진행 단계를 판단한다. " +
  "에이전트들은 사용자 보고 없이 인계만 남기기도 하니, 인계로 부족하면 바뀐 파일·git diff를 직접 읽어 정리한다.";

/** 진입점·프로젝트 파일 — 여러 에이전트가 각자 다른 곳에 만들면 같은 결과물을 따로 만든 것일 수 있다 */
const ENTRY = /^(program\.cs|main\.[a-z]+|index\.[jt]sx?|app\.[a-z]+|package\.json|cargo\.toml|pyproject\.toml|go\.mod|[^/]+\.(csproj|sln|vcxproj))$/i;
/** 다른 에이전트 결과물의 대역으로 보이는 이름 */
const STANDIN = /(^|[\/_.-])(mock|fake|dummy)/i;

/**
 * 지시 하나가 끝난 뒤 에이전트별로 고친 파일(저장소 기준 경로) → 겹친 일로 의심되는 것(사람이 읽는 줄).
 * 같은 파일을 둘 이상이 고침 · 같은 역할 파일(진입점·프로젝트 파일)을 둘 이상이 각자 다른 곳에 만듦 · 대역(mock·fake·dummy)으로 보이는 파일
 */
export function overlapsFrom(lanes: { name: string; files: string[] }[]): string[] {
  const out: string[] = [];
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const byPath = new Map<string, string[]>();
  const shown = new Map<string, string>();
  const byEntry = new Map<string, { name: string; path: string }[]>();
  for (const l of lanes) {
    for (const f of new Set(l.files.map(norm))) {
      const k = f.toLowerCase();
      byPath.set(k, [...(byPath.get(k) ?? []), l.name]);
      if (!shown.has(k)) shown.set(k, f);
      const base = f.split("/").pop() ?? f;
      if (ENTRY.test(base)) {
        const ek = base.toLowerCase().replace(/^[^/]+\.(csproj|sln|vcxproj)$/, "*.$1");
        byEntry.set(ek, [...(byEntry.get(ek) ?? []), { name: l.name, path: f }]);
      }
      if (STANDIN.test(f)) out.push(`대역으로 보이는 파일: ${f} (${l.name}) — 다른 에이전트가 맡은 결과물을 따로 흉내 낸 것인지 확인`);
    }
  }
  for (const [p, names] of byPath) if (new Set(names).size > 1) out.push(`같은 파일을 여럿이 고침: ${shown.get(p) ?? p} — ${[...new Set(names)].join("·")}`);
  for (const [base, list] of byEntry) {
    const names = [...new Set(list.map((x) => x.name))];
    const paths = new Set(list.map((x) => x.path.toLowerCase()));
    if (names.length > 1 && paths.size > 1) out.push(`같은 역할 파일(${base})을 여러 곳에 만듦: ${list.map((x) => `${x.name} ${x.path}`).join(" / ")}`);
  }
  return out;
}

/** 브리핑 글에 담을 에이전트 결과 전체 글자 수(에이전트 수로 나눈다) */
const BRIEF_BUDGET = 8000;
/** 길면 앞 60%·끝 40%만(끝에 인계가 있다) */
function clip(t: string, max: number): string {
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.6);
  return `${t.slice(0, head)}\n…(줄임)…\n${t.slice(t.length - (max - head))}`;
}

/** 지시 하나가 끝났을 때 브리핑 담당에게 보낼 글 */
/** overlaps: overlapsFrom()이 찾은 겹침 의심 줄 */
export function briefPrompt(o: { instruction: string; results: { name: string; answer: string }[]; files?: string; overlaps?: string[] }): string {
  // 에이전트 결과는 앞부분과 끝(인계)만 — 길게 다 넣으면 브리핑 에이전트의 대화가 금방 차서 압축도 못 하게 된다
  const per = Math.max(800, Math.floor(BRIEF_BUDGET / Math.max(1, o.results.length)));
  const res = o.results.map((r) => `## ${r.name}\n${clip(r.answer.trim(), per) || "(답 없음)"}`).join("\n\n");
  const files = clip(o.files?.trim() ?? "", 1500);
  return `${BRIEF_RULE}

[사용자 지시]
${o.instruction}

[에이전트별 결과]
${res || "(없음)"}
${files ? `\n[바뀐 파일]\n${files}\n` : ""}${o.overlaps?.length ? `\n[겹침 의심(앱이 고친 파일로 찾은 것)]\n${o.overlaps.slice(0, 12).map((x) => `- ${x}`).join("\n")}\n` : ""}
아래 형식으로 한국어로 짧게(각 1~4줄):
### 완성된 것
### 지금 단계
### 테스트해 볼 수 있는 것 (어떻게 — 실행할 명령·눌러 볼 화면)
### 겹친 일 (같은 일·같은 결과물을 여러 에이전트가 따로 한 것 — 겹침 의심과 결과를 보고 판단, 없으면 "없음")
### 막힌 것·결정이 필요한 것 (없으면 "없음")`;
}

/** 사용자가 브리핑 에이전트에 직접 물어볼 때 */
export const briefAsk = (text: string) => `${BRIEF_RULE}

[사용자 질문]
${text}`;
