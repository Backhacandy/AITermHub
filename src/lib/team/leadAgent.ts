// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀장 에이전트: 사용자와 대화하고, 답 끝의 ```aith-lead``` JSON 블록으로 할 일(배치·만들기·역할 조정·확인 요청)을 낸다.
// 앱은 그 블록만 읽어 확인을 받을지 바로 실행할지 정한다. 모두 토큰 0, 로컬 규칙.

import { isWorker, uniqueName, type Member } from "./team";
import { modelGuide, stagesOf } from "./distribute";
import { LANE_MODELS, EFFORTS } from "$lib/pair/models";
import { scopeLimited } from "$lib/pair/rounds";
import { MODES, modelForMode, modeRules, type TeamMode } from "./mode";

export type LeadAction =
  | { type: "assign"; to: string; task: string; after?: string[] }
  | { type: "create"; name: string; cli: "claude" | "codex"; model: string; effort?: string; purpose: string; areas: string[]; home?: boolean; chrome?: boolean }
  | { type: "role"; name: string; purpose?: string; areas?: string[]; chrome?: boolean; model?: string; effort?: string }
  /** 에이전트 브랜치들을 사용자의 지금 브랜치에 합치기(확인은 앱이 팀 설정대로) */
  | { type: "merge"; title?: string; body?: string };

export interface LeadConfirm {
  kind: "plan" | "allocation" | "other";
  title: string;
  body: string;
  files?: string[];
}

export interface LeadReply {
  /** 사용자에게 하는 말(블록 밖 글) */
  say: string;
  purpose?: string;
  scope?: string;
  /** 큰 요청이라 배치를 확인받고 시작 */
  wait: boolean;
  actions: LeadAction[];
  confirm?: LeadConfirm;
}

export const LEAD_BLOCK = "aith-lead";

/** 팀 인원 상한(팀장 제외) — 4단계에서 운영 방식(라이트·맥스)이 정한다 */
export const TEAM_CAP = 8;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function action(x: unknown): LeadAction | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (o.type === "assign") {
    const to = str(o.to);
    const task = str(o.task);
    if (!to || !task) return null;
    const after = strs(o.after);
    return after.length ? { type: "assign", to, task, after } : { type: "assign", to, task };
  }
  if (o.type === "create") {
    const name = str(o.name);
    const cli = o.cli === "codex" ? "codex" : o.cli === "claude" ? "claude" : null;
    if (!name || !cli) return null;
    const effort = str(o.effort);
    return { type: "create", name, cli, model: str(o.model) || "auto", ...(effort ? { effort } : {}), purpose: str(o.purpose), areas: strs(o.areas), ...(o.home === true ? { home: true } : {}), ...(o.chrome === true ? { chrome: true } : {}) };
  }
  if (o.type === "merge") {
    const title = str(o.title);
    const body = str(o.body);
    return { type: "merge", ...(title ? { title } : {}), ...(body ? { body } : {}) };
  }
  if (o.type === "role") {
    const name = str(o.name);
    const purpose = str(o.purpose);
    const areas = Array.isArray(o.areas) ? strs(o.areas) : undefined;
    const chrome = typeof o.chrome === "boolean" ? o.chrome : undefined;
    const model = str(o.model);
    const effort = typeof o.effort === "string" ? o.effort.trim() : undefined;
    if (!name || (!purpose && !areas && chrome === undefined && !model && effort === undefined)) return null;
    return { type: "role", name, ...(purpose ? { purpose } : {}), ...(areas ? { areas } : {}), ...(chrome !== undefined ? { chrome } : {}), ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
  }
  return null;
}

/** 팀장 답 → 사용자에게 할 말 + 할 일. 블록이 없거나 깨지면 말만 */
export function parseLeadReply(text: string): LeadReply {
  const re = new RegExp("```" + LEAD_BLOCK + "\\s*\\n([\\s\\S]*?)```", "g");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return { say: text.trim(), wait: false, actions: [] };
  const say = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(last[1]);
  } catch {
    return { say, wait: false, actions: [] };
  }
  if (!raw || typeof raw !== "object") return { say, wait: false, actions: [] };
  const out: LeadReply = { say, wait: raw.wait === true, actions: (Array.isArray(raw.actions) ? raw.actions : []).map(action).filter((a): a is LeadAction => !!a) };
  const purpose = str(raw.purpose);
  const scope = str(raw.scope);
  if (purpose) out.purpose = purpose;
  if (scope) out.scope = scope;
  const c = raw.confirm as Record<string, unknown> | undefined;
  if (c && typeof c === "object") {
    const kind = c.kind === "plan" || c.kind === "allocation" ? c.kind : "other";
    const files = strs(c.files);
    out.confirm = { kind, title: str(c.title), body: str(c.body), ...(files.length ? { files } : {}) };
  }
  return out;
}

/** 확인받고 시작할 배치인지: 큰 요청(wait)이거나 새로 만들기·역할 바꾸기가 있으면 */
export const needsConfirm = (r: LeadReply): boolean =>
  r.wait || r.actions.some((a) => a.type === "create" || (a.type === "role" && (a.purpose !== undefined || a.areas !== undefined || a.chrome !== undefined)));

/** 기획 관문: 지시에 기획이 들어 있고 아직 기획 확인을 받지 않았으면 다음 단계 배치는 확인부터 */
export const planGate = (instruction: string, planConfirmed: boolean): boolean => /기획/.test(instruction) && !planConfirmed;

export function leadMember(members: Member[]): Omit<Member, "id"> {
  return {
    name: uniqueName("팀장", members),
    cli: "claude",
    model: "opus",
    effort: "high",
    purpose: "나누기·챙기기·보고(코드는 고치지 않음)",
    areas: [],
    lean: true,
    lead: true,
    notes: [],
  };
}

/** 옛 팀 → 팀장이 있는 팀: 브리핑 담당은 빠지고(팀장이 맡음) 팀장이 맨 앞. 나머지 에이전트(대화·모델·역할)는 그대로 */
export function migrateTeam(members: Member[]): { members: Member[]; changed: boolean } {
  if (members.some((m) => m.lead)) return { members, changed: false };
  const rest = members.filter((m) => !m.brief);
  let id = "lead";
  for (let i = 2; rest.some((m) => m.id === id); i++) id = `lead${i}`;
  return { members: [{ ...leadMember(rest), id }, ...rest], changed: true };
}

export interface LeadTurn {
  kind: "user" | "results" | "confirmed" | "revise" | "direct" | "merge";
  text: string;
  results?: { name: string; answer: string }[];
  files?: string;
  overlaps?: string[];
  /** 앱이 다시 켜지며 끊긴 일(results 차례에 함께): 중간에 끊긴 에이전트 · 시작 못 한 에이전트 */
  restart?: { cut: string[]; notStarted: string[] };
}

const LEAD_RULES = `[팀장] 너는 이 팀의 팀장이다. 사용자는 너하고만 대화한다. 에이전트들은 사용자에게 말하지 않고 인계만 남긴다.
- 코드·파일은 절대 고치지 않는다. 판단에 필요하면 읽기·git status/diff 확인만 한다.
- 배치하기 전에 "이번 요청의 목적"과 "이번 범위"를 한두 줄로 먼저 되짚는다. 사용자 목적과 다른 배치는 가장 큰 실패다.
- 누구에게 맡길지는 적합성으로 고른다: ① 기존 에이전트에게 기존 역할대로 ② 기존 역할을 아주 조금 바꾸거나 하나 덧붙이기 ③ 새 에이전트 만들기. 역할을 바꾸거나 사람을 늘리면 사용자에게 한 줄로 알린다.
- 같은 결과물을 둘 이상에게 맡기지 않는다. 앞 결과가 있어야 하는 일은 after로 순서를 정한다.
- 요청에 기획이 들어 있으면 기획까지만 맡기고, 기획 결과가 오면 confirm.kind "plan"으로 멈춰 주제·기획을 보여 준다. 사용자가 확인하기 전에는 다음 단계를 맡기지 않는다.
- 사용자가 범위를 정했으면(~만, ~까지만, ~하지 마) 그 범위 밖 일은 맡기지 않는다.
- 큰 요청(여러 단계·여러 에이전트·오래 걸림)이면 wait: true로 배치를 확인받고 시작한다.
- 결과가 오면 사용자에게 짧게 보고한다: 완성된 것 · 지금 단계 · 테스트해 볼 수 있는 것(방법) · 막힌 것. 남은 일이 요청 범위 안이면 다음 배치를 낸다.
- 에이전트 상태는 앱이 알려 주는 것을 믿는다. "작업 중"·"백그라운드 작업 중"이면 결과가 오니 기다리고, "쉬는 중"인데 맡긴 일의 결과를 아직 못 받았으면 기다리지 말고 그 에이전트에게 "맡은 일의 결과와 인계를 다시 내라"를 맡긴다(assign). 쉬는 에이전트를 기다린다고만 하고 멈추지 않는다.
- 에이전트는 각자 자기 git 브랜치(작업 폴더)에서 일한다. 결과가 요청 범위를 다 채웠고 문제가 없으면 {"type":"merge"}를 낸다(사용자 확인은 앱이 받는다). title에는 커밋·PR 제목 한 줄(이 저장소의 커밋 제목 말투로, 예: feat(frontend): 로그인 화면), body에는 PR 설명(무엇을 바꿨고 어떻게 확인하는지, 짧게)을 넣는다 — 남의 저장소에서는 그대로 커밋·PR에 쓰인다. 문제가 있으면 merge 대신 고칠 배치를 낸다.
- merge와 맡길 일을 한 번에 내면 앱이 먼저 합치고(그때 쉬는 에이전트 몫만, 다른 브랜치도 맞춘 뒤) 일을 맡긴다. 합친 결과는 그 일의 결과와 함께 "앱(합치기)"로 온다 — 합치기가 빠지거나 멈췄으면 거기에 적혀 있다.
- [합치기 결과]로 충돌이 오면 그 에이전트에게 "원래 브랜치를 자기 브랜치에 합치고 충돌을 풀어라"를 맡긴다.
- {cap}
{models}
- 일마다 알맞은 모델로: 이미 있는 에이전트의 모델·생각을 바꾸려면 {"type":"role","name":"이름","model":"모델","effort":"생각"}을 낸다(사용자 확인 없이 바로 바뀌고, 다음 일부터 그 모델로 한다). 새 모델이 나와 옛 모델을 쓰던 에이전트에게 새 모델이 더 맞으면 바꾼다. 같은 에이전트의 모델을 일마다 오락가락 바꾸지는 않는다.
- 사용자에게 하는 말은 블록 밖에 평범한 글로 쓰고, 할 일은 답 맨 끝에 아래 블록 하나로만 낸다(할 일이 없으면 actions를 비운다):
\`\`\`${LEAD_BLOCK}
{"purpose":"이번 요청의 목적","scope":"이번 범위","wait":false,
 "actions":[
  {"type":"assign","to":"에이전트 이름","task":"맡길 일(구체적으로)","after":["먼저 끝나야 하는 에이전트 이름"]},
  {"type":"create","name":"QA","cli":"claude","model":"sonnet","effort":"high","purpose":"맡을 일","areas":["Tests/**"]},
  {"type":"role","name":"UI","purpose":"바뀐 맡을 일","areas":["Assets/UI/**"]},
  {"type":"merge","title":"feat: 바뀐 것 한 줄","body":"무엇을 바꿨고 어떻게 확인하는지"}
 ],
 "confirm":{"kind":"plan","title":"기획 확인","body":"주제와 기획 요약","files":["Docs/GDD.md"]}}
\`\`\`
- confirm은 사용자 확인이 필요할 때만 넣는다.`;

/** 결과 글은 앞 60%·끝 40%만(끝에 인계가 있다) */
function clip(t: string, max: number): string {
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.6);
  return `${t.slice(0, head)}\n…(줄임)…\n${t.slice(t.length - (max - head))}`;
}
const RESULTS_BUDGET = 8000;

function body(t: LeadTurn): string {
  switch (t.kind) {
    case "user":
      return `[사용자 지시]\n${t.text}`;
    case "confirmed":
      return `[사용자 확인]\n${t.text}`;
    case "revise":
      return `[사용자가 고치래요]\n${t.text}`;
    case "merge":
      return `[합치기 결과]\n${t.text}`;
    case "results":
    case "direct": {
      const res = t.results ?? [];
      const per = Math.max(800, Math.floor(RESULTS_BUDGET / Math.max(1, res.length)));
      const list = res.map((r) => `## ${r.name}\n${clip(r.answer.trim(), per) || "(답 없음)"}`).join("\n\n");
      const files = clip(t.files?.trim() ?? "", 1500);
      const head = t.kind === "results" ? `[처음 사용자 지시]\n${t.text}\n\n[에이전트별 결과]` : `[사용자가 @이름에게 직접 시킨 일의 결과]\n지시: ${t.text}`;
      return `${head}\n${list || "(없음)"}${files ? `\n\n[바뀐 파일]\n${files}` : ""}${t.overlaps?.length ? `\n\n[겹침 의심(앱이 고친 파일로 찾은 것)]\n${t.overlaps.slice(0, 12).map((x) => `- ${x}`).join("\n")}` : ""}${t.restart ? restartText(t.restart, res.length > 0) : ""}`;
    }
  }
}

/** 팀장에게 보낼 글. full이면 팀장 규칙부터(대화 처음·구성 변경·압축 뒤) */
/** kind: 프로젝트 종류(team_kind) — 엔진 프로젝트면 에디터·플레이 테스트 안내 */
/** 앱이 다시 켜졌을 때 팀장에게 — 끊긴 에이전트는 처음부터가 아니라 끊긴 지점부터 이어서 */
function restartText(r: { cut: string[]; notStarted: string[] }, hasResults: boolean): string {
  const lines = ["[앱 재시작] 앱이 다시 켜지며(업데이트 등) 하던 일이 끊겼다. 에이전트들은 지금 모두 쉬고 있다."];
  if (hasResults) lines.push("- 위 [에이전트별 결과]는 재시작 전에 끝났지만 아직 너에게 가지 못한 결과다.");
  if (r.cut.length) lines.push(`- 중간에 끊긴 에이전트(결과 없음): ${r.cut.join(", ")} — 각자 작업 폴더·커밋에 남은 것을 확인하고 끊긴 지점부터 이어서 마무리하라고 맡긴다(처음부터 다시 하지 않게). 돌려 두던 빌드·테스트도 끊겼으니 다시 돌리게 한다.`);
  if (r.notStarted.length) lines.push(`- 차례를 기다리다 시작하지 못한 에이전트: ${r.notStarted.join(", ")} — 맡기려던 일을 다시 맡긴다.`);
  lines.push("- 사용자에게는 재시작으로 끊겼다가 이어서 한다고 한 줄만 알린다.");
  return `\n\n${lines.join("\n")}`;
}

export function leadPrompt(o: { turn: LeadTurn; members: Member[]; status: Record<string, string>; notes: string[]; full: boolean; cap: number; kind?: string; mode?: TeamMode; mergeAsk?: boolean }): string {
  const team = o.members
    .filter((m) => !m.lead)
    .map((m) => `- ${m.name}(${m.cli} · ${m.model}${m.effort ? ` · 생각 ${m.effort}` : ""}): ${m.purpose || "맡을 일 미지정"} · 영역 ${m.areas.join(", ") || "지정 없음"} · ${o.status[m.id] ?? "상태 모름"}`)
    .join("\n");
  const notes = o.notes.length ? `\n\n[팀장 메모 — 사용자가 고친 것, 꼭 지킬 것]\n${o.notes.map((n) => `- ${n}`).join("\n")}` : "";
  const rules = o.full ? `${LEAD_RULES.replace("{models}", modelGuide()).replace("{cap}", Number.isFinite(o.cap) ? `에이전트 인원은 팀장을 빼고 최대 ${o.cap}명.` : "에이전트 인원 상한은 없다. 다만 한 명마다 PC 메모리를 쓰니 일을 나눌 필요가 있을 때만 만들고, 쉬는 사람에게 맡길 수 있으면 새로 만들지 않는다.")}\n\n` : "";
  const engine =
    o.kind === "unity" || o.kind === "unreal"
      ? `[프로젝트] ${o.kind === "unity" ? "Unity" : "Unreal"} 엔진 프로젝트: 브랜치에서 일하는 에이전트는 에디터를 열지 않고 코드만 고친다. 플레이 테스트는 원래 폴더에서 일하는 담당(create에 "home":true)에게 합친 뒤에만 맡긴다.\n\n`
      : "";
  const mode = o.mode ? `[운영 방식] ${MODES[o.mode].label} — ${modeRules(o.mode)}\n\n` : "";
  // 사용자가 '합치기 전에 물어보기'를 껐으면 팀장도 합칠지 묻지 않는다(앱이 묻지 않고 바로 합친다)
  const merge = o.mergeAsk === false ? "[합치기] 사용자가 합치기 확인을 껐다. 합칠지 사용자에게 묻지 말고, 결과에 문제가 없으면 바로 merge를 낸다(검증이 필요하면 검증을 먼저 맡긴다).\n\n" : "";
  return `${rules}${mode}${merge}${engine}[팀]\n${team || "- (아직 없음 — 필요하면 create로 만든다)"}${notes}\n\n${body(o.turn)}`;
}

/** 팀장 메모에 하나 더(공백 정리, 겹치면 그대로, 마지막 20개) */
export function addLeadNote(notes: string[], text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || notes.includes(t)) return notes;
  return [...notes, t].slice(-20);
}


export interface LeadPlan {
  /** 만들 에이전트(이름 겹치지 않게, 모델·생각은 목록에 있는 것만) */
  creates: Omit<Member, "id">[];
  /** 바꿀 역할(note: 사람이 읽는 한 줄) */
  roles: { id: string; purpose?: string; areas?: string[]; chrome?: boolean; model?: string; maxModel?: string; effort?: string; note: string }[];
  /** 이름 기준 배치(만들 에이전트 포함) */
  assign: { name: string; task: string; after: string[] }[];
  /** 실행하지 않은 것과 이유 */
  errors: string[];
  /** 합치기를 냈는지 */
  merge: boolean;
  /** 합치기 커밋·PR 제목과 설명(팀장이 냈으면) */
  mergeTitle?: string;
  mergeBody?: string;
}

const bare = (n: string) => n.replace(/^@/, "").trim();
const same = (a: string, b: string) => bare(a).toLowerCase() === bare(b).toLowerCase();

/** 팀장 행동 → 실제로 할 일(상한·없는 이름·팀장에게 맡기기는 실행하지 않고 이유로) */
/** maxTier: 운영 방식이 허용하는 모델 등급 상한(라이트 3) — 넘으면 그 CLI의 허용 등급 중 가장 높은 모델로 */
export function planActions(members: Member[], actions: LeadAction[], cap: number, maxTier = 5): LeadPlan {
  const out: LeadPlan = { creates: [], roles: [], assign: [], errors: [], merge: false };
  const workers = members.filter(isWorker).length;
  for (const a of actions) {
    if (a.type === "merge") {
      out.merge = true;
      if (a.title) out.mergeTitle = a.title;
      if (a.body) out.mergeBody = a.body;
      continue;
    }
    if (a.type === "create") {
      if (workers + out.creates.length >= cap) {
        out.errors.push(`인원 상한 ${cap}명이라 ${a.name}는 만들지 않았어요`);
        continue;
      }
      if (members.some((m) => same(m.name, a.name)) || out.creates.some((c) => same(c.name, a.name))) {
        out.errors.push(`${a.name}: 이미 있는 이름이라 새로 만들지 않았어요`);
        continue;
      }
      // 운영 방식 등급을 넘으면 낮추고 원래 모델을 기억(맥스로 바꾸면 되돌린다)
      const mm = modelForMode(a.cli, LANE_MODELS[a.cli].some((m) => m.id === a.model) ? a.model : "auto", undefined, maxTier);
      const model = mm.model;
      const effort = a.effort && EFFORTS[a.cli].some((e) => e.id === a.effort) ? a.effort : undefined;
      out.creates.push({ name: bare(a.name), cli: a.cli, model, ...(mm.maxModel ? { maxModel: mm.maxModel } : {}), ...(effort ? { effort } : {}), purpose: a.purpose, areas: a.areas, lean: true, ...(a.home ? { home: true } : {}), ...(a.chrome ? { chrome: true } : {}) });
    } else if (a.type === "role") {
      const m = members.find((x) => isWorker(x) && same(x.name, a.name));
      if (!m) {
        out.errors.push(`${bare(a.name)}: 없는 에이전트라 역할을 바꾸지 못했어요`);
        continue;
      }
      // 모델·생각: 그 CLI 목록에 있는 것만, 운영 방식 등급을 넘으면 낮추고 원래 모델을 기억
      let mm: { model: string; maxModel?: string } | undefined;
      if (a.model !== undefined) {
        if (LANE_MODELS[m.cli].some((x) => x.id === a.model)) mm = modelForMode(m.cli, a.model, undefined, maxTier);
        else out.errors.push(`${m.name}: ${a.model}는 ${m.cli} 모델 목록에 없어 모델은 그대로 둬요`);
      }
      const effort = a.effort !== undefined && EFFORTS[m.cli].some((e) => e.id === a.effort) ? a.effort : undefined;
      if (a.effort !== undefined && effort === undefined) out.errors.push(`${m.name}: 생각 깊이 ${a.effort}는 쓸 수 없어 그대로 둬요`);
      const what = [a.purpose !== undefined ? "맡을 일" : "", a.areas !== undefined ? "담당 경로" : "", a.chrome !== undefined ? `브라우저 ${a.chrome ? "켬" : "끔"}` : "", mm ? `모델 ${mm.model}` : "", effort !== undefined ? `생각 ${effort || "기본"}` : ""].filter(Boolean).join("·");
      if (!what) continue;
      out.roles.push({ id: m.id, ...(a.purpose !== undefined ? { purpose: a.purpose } : {}), ...(a.areas !== undefined ? { areas: a.areas } : {}), ...(a.chrome !== undefined ? { chrome: a.chrome } : {}), ...(mm ? { model: mm.model, ...(mm.maxModel ? { maxModel: mm.maxModel } : {}) } : {}), ...(effort !== undefined ? { effort } : {}), note: `${m.name}: ${what}` });
    } else {
      const m = members.find((x) => same(x.name, a.to));
      if (m && !isWorker(m)) {
        out.errors.push(`${m.lead ? "팀장" : m.name}에게는 일을 맡길 수 없어요`);
        continue;
      }
      out.assign.push({ name: bare(a.to), task: a.task, after: (a.after ?? []).map(bare) });
    }
  }
  return out;
}

/** 이름 기준 배치 → 에이전트 id·몫·단계(after) */
export function resolveAssign(members: Member[], assign: LeadPlan["assign"]): { ids: string[]; preset: Record<string, string>; order: string[][]; errors: string[] } {
  const idOf = (n: string) => members.find((m) => isWorker(m) && same(m.name, n))?.id;
  const errors: string[] = [];
  const list: { id: string; after: string[] }[] = [];
  const preset: Record<string, string> = {};
  for (const a of assign) {
    const id = idOf(a.name);
    if (!id) {
      errors.push(`${a.name}: 없는 에이전트라 맡기지 못했어요`);
      continue;
    }
    if (preset[id]) preset[id] = `${preset[id]}\n${a.task}`;
    else {
      preset[id] = a.task;
      list.push({ id, after: a.after.map(idOf).filter((x): x is string => !!x) });
    }
  }
  return { ids: list.map((x) => x.id), preset, order: stagesOf(list), errors };
}


/**
 * 팀장 답의 배치를 바로 실행할지, 확인부터 받을지.
 * - 팀장이 청한 확인(confirm)·큰 배치(wait)·만들기·역할 바꾸기 → 확인
 * - 첫 배치(user 차례)에서 기획 관문이면 확인 없이 첫 단계만(after가 있는 뒤 단계는 기획 확인 뒤로)
 * - 그 밖의 차례(결과·직접·고치기·확인)에서 기획 확인 전이면 → 기획 확인, 범위 제한·후속 상한(결과·직접 차례)이면 → 배치 확인
 */
export function leadGate(o: { turn: LeadTurn["kind"]; reply: LeadReply; instruction: string; planConfirmed: boolean; rounds: number; limit: number }): { kind: LeadConfirm["kind"] | null; firstStageOnly: boolean; limit?: true } {
  const r = o.reply;
  if (r.confirm) return { kind: r.confirm.kind, firstStageOnly: false };
  // 합치기만 낸 답은 관문 없이(합치기 확인은 팀 설정대로 따로)
  if (!r.actions.some((a) => a.type !== "merge")) return { kind: null, firstStageOnly: false };
  if (needsConfirm(r)) return { kind: "allocation", firstStageOnly: false };
  const gate = planGate(o.instruction, o.planConfirmed);
  if (o.turn === "user") return { kind: null, firstStageOnly: gate };
  if (gate) return { kind: "plan", firstStageOnly: false };
  const after = o.turn === "results" || o.turn === "direct";
  if (after && scopeLimited(o.instruction)) return { kind: "allocation", firstStageOnly: false };
  if (after && o.rounds >= o.limit) return { kind: "allocation", firstStageOnly: false, limit: true };
  return { kind: null, firstStageOnly: false };
}

/** 첫 단계만: 앞 결과가 있어야 하는 배치(after)는 뒤로 */
export function firstStage(actions: LeadAction[]): { now: LeadAction[]; later: LeadAction[] } {
  const later = actions.filter((a) => a.type === "assign" && !!a.after?.length);
  return { now: actions.filter((a) => !later.includes(a)), later };
}

/** 합치기 결과를 팀장에게 알릴 글 — 합쳤으면 계획한 다음 단계를 이어 가게, 충돌·실패가 있으면 그 몫과 함께. 알릴 게 없으면 null */
export function mergeTurnText(
  r: {
    merged: string[];
    conflicts: { member: string; files: string[] }[];
    failed: { member: string; error: string }[];
    head: string;
    /** 일하는 중이라 이번 합치기에서 뺀 에이전트 */
    busy?: string[];
    /** 브랜치에 새 커밋이 없어 합칠 게 없던 에이전트 */
    nothing?: string[];
  },
  name: (id: string) => string,
): string | null {
  const issues = [...r.conflicts.map((c) => `${name(c.member)}: ${c.files.join(", ") || "(파일 모름)"}`), ...r.failed.map((f) => `${name(f.member)}: ${f.error}`)];
  const busy = r.busy ?? [];
  const nothing = r.nothing ?? [];
  if (!r.merged.length && !issues.length && !busy.length && !nothing.length) return null;
  const done = r.merged.length ? `합친 것: ${r.merged.map(name).join(", ")}${r.head ? ` (${r.head})` : ""}` : "합친 것 없음";
  // 빠진 까닭 — 팀장이 "합쳐졌겠지" 하고 기다리지 않게
  const left = [
    busy.length ? `- 아직 일하는 중이라 이번 합치기에서 빠진 것: ${busy.map(name).join(", ")} — 그 에이전트의 결과가 오면 다시 merge를 내라.` : "",
    nothing.length ? `- 브랜치에 새 커밋이 없어 합칠 게 없던 것: ${nothing.map(name).join(", ")} — 그 몫이 끝났다고 봤다면 작업 폴더에 남겼는지 확인하게 하라.` : "",
  ].filter(Boolean);
  if (!issues.length) {
    const head = r.merged.length ? `${done}. 사용자의 지금 브랜치에 들어갔다.` : `${done}. 사용자 브랜치는 그대로다.`;
    const tail = busy.length ? "" : " 계획해 둔 다음 단계가 있으면 이어서 배치하라. 남은 일이 없으면 사용자에게 마무리를 보고하라.";
    return [head + tail, ...left].join("\n");
  }
  return [`합치지 못한 몫이 있다(그 몫은 사용자 브랜치에 들어가지 않았다 · ${done}).`, ...issues.map((x) => `- ${x}`), ...left].join("\n");
}
