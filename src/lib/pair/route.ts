// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Claude + Codex 2인 협업: 역할 판단·담당 영역 감지·인계 메모 추출(모두 토큰 0, 로컬 규칙).

import { CODEX_PATCH_RULE } from "$lib/work/codexRules";
import { matchOwns } from "$lib/collab/ownership";

export type Agent = "claude" | "codex";
export type Role = "front" | "back";

export interface Roles {
  /** 백엔드 담당 */
  back: Agent;
  /** 프론트 담당 */
  front: Agent;
}

export const DEFAULT_ROLES: Roles = { back: "codex", front: "claude" };

export const ROLE_LABEL: Record<Role, string> = { front: "프론트", back: "백엔드" };

export interface RoutePlan {
  /** 이번 지시에서 일할 에이전트(순서대로: 백엔드 먼저) */
  order: Agent[];
  /** 왜 이렇게 나눴는지(화면 안내용) */
  reason: string;
  /** @멘션을 뺀 실제 지시 */
  text: string;
}

/**
 * `@` 뒤 단어 → 에이전트. 영문은 2자 이상 접두어(`cl`, `cla`, `co`, `cod` …), 한글은 `클`/`클로드`/`코`/`코덱스`.
 * `c`처럼 모호하거나 다른 단어면 null(지시문에 그대로 둔다).
 */
export function mentionOf(word: string): Agent | null {
  const w = word.toLowerCase();
  if (w === "클" || w === "클로드") return "claude";
  if (w === "코" || w === "코덱스") return "codex";
  if (w.length < 2) return null;
  if ("claude".startsWith(w)) return "claude";
  if ("codex".startsWith(w)) return "codex";
  return null;
}

/**
 * 지시를 누가 할지 정한다.
 * - `@claude` / `@codex`(약자 `@cl` / `@co`, 한글 `@클` / `@코`)가 있으면 그 에이전트만(둘 다 있으면 둘 다)
 * - 아니면 늘 둘 다(백엔드 → 프론트). 단어로 짐작해 한쪽만 보내지 않는다(엉뚱한 단어에 걸려 몰래 나뉘던 문제)
 */
export function routeInstruction(raw: string, roles: Roles): RoutePlan {
  const mentions = new Set<Agent>();
  const text = raw
    .replace(/(^|\s)@([a-z]+|[가-힣]+)(?=\s|$|[,.!?:])/gi, (all, pre: string, word: string) => {
      const a = mentionOf(word);
      if (!a) return all;
      mentions.add(a);
      return pre;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  const backFirst = (list: Agent[]) => [...list].sort((a) => (a === roles.back ? -1 : 1));

  if (mentions.size) {
    const order = backFirst([...mentions]);
    return { order, reason: `지정: ${order.map((a) => (a === "claude" ? "Claude" : "Codex")).join(" → ")}`, text };
  }
  return { order: [roles.back, roles.front], reason: "둘 다", text };
}

/** 역할 바꾸기 지시("역할 바꿔", "codex가 프론트") 감지 → 새 역할, 없으면 null */
export function roleSwitch(raw: string, roles: Roles): Roles | null {
  const t = raw.toLowerCase().replace(/\s+/g, "");
  if (/역할(을)?(서로)?바꿔|역할교체|swaproles/.test(t)) return { back: roles.front, front: roles.back };
  const m = t.match(/(?<![a-z])(claude|클로드|codex|코덱스|cl|co|클|코)(가|이|는|은)?(프론트|front|백엔드|backend)/);
  if (!m) return null;
  const who: Agent = ["claude", "클로드", "cl", "클"].includes(m[1]) ? "claude" : "codex";
  const other: Agent = who === "claude" ? "codex" : "claude";
  return m[3].startsWith("프") || m[3] === "front" ? { front: who, back: other } : { back: who, front: other };
}

// ---------- 담당 영역 자동 감지 ----------

export interface Areas {
  front: string[];
  back: string[];
}

const FRONT_DIRS = ["src/routes", "src/lib/components", "src/components", "src/pages", "pages", "app", "components", "public", "static", "frontend", "web", "client", "ui", "styles", "src/styles", "src/app"];
const BACK_DIRS = ["src-tauri", "server", "backend", "api", "src/server", "src/api", "db", "migrations", "prisma", "services", "cmd", "internal"];
const FRONT_EXT = ["**/*.svelte", "**/*.vue", "**/*.tsx", "**/*.jsx", "**/*.css", "**/*.scss", "**/*.html"];
const BACK_EXT = ["**/*.rs", "**/*.py", "**/*.go", "**/*.java", "**/*.sql"];

/** 안쪽 폴더도 이름이 이러면 그 경로 그대로 영역으로(예: example-web/frontend) */
const FRONT_NAMES = new Set(["frontend", "web", "client", "ui", "components", "pages", "public", "static", "styles", "android", "ios", "mobile"]);
const BACK_NAMES = new Set(["backend", "server", "api", "db", "migrations", "prisma", "services", "src-tauri", "internal", "sql"]);
const nameSide = (name: string): "front" | "back" | null =>
  FRONT_NAMES.has(name) || /android|ios$|mobile/.test(name) ? "front" : BACK_NAMES.has(name) ? "back" : null;

/**
 * 저장소의 폴더 목록(상대경로, `/` 구분, 몇 단계 안쪽까지)으로 프론트/백엔드 영역을 추정.
 * 알려진 경로(src/routes 등)는 그대로, 그 밖에는 폴더 이름으로. 이미 잡힌 폴더의 안쪽은 또 잡지 않는다.
 */
export function detectAreas(dirs: string[]): Areas {
  // 비교는 소문자로, 영역 경로는 원래 대소문자 그대로(파일 경로와 맞춰 보므로)
  const paths = [...new Set(dirs.map((d) => d.replace(/\\/g, "/").replace(/\/+$/, "")))].sort((a, b) => a.split("/").length - b.split("/").length);
  const side: Record<"front" | "back", string[]> = { front: [], back: [] };
  const taken = (p: string) => [...side.front, ...side.back].some((q) => p.toLowerCase() === q.toLowerCase() || p.toLowerCase().startsWith(`${q.toLowerCase()}/`));
  for (const p of paths) {
    if (taken(p)) continue;
    const low = p.toLowerCase();
    const s = FRONT_DIRS.includes(low) ? "front" : BACK_DIRS.includes(low) ? "back" : nameSide(low.split("/").pop() ?? "");
    if (s) side[s].push(p);
  }
  return { front: [...side.front.map((d) => `${d}/**`), ...FRONT_EXT], back: [...side.back.map((d) => `${d}/**`), ...BACK_EXT] };
}

/** 이 에이전트가 고친 파일(저장소 기준 경로) 중 상대 영역이고 내 영역은 아닌 것 */
export function trespass(paths: string[], me: Agent, roles: Roles, areas: Areas): string[] {
  const mine: Role = roles.back === me ? "back" : "front";
  const other: Role = mine === "back" ? "front" : "back";
  return paths.filter((p) => matchOwns(p, areas[other]) && !matchOwns(p, areas[mine]));
}

// ---------- 인계 메모 ----------

const MEMO_MAX = 900;

/**
 * 답변 끝의 "### 인계" 섹션을 꺼낸다(없으면 마지막 몇 줄). 두 에이전트 사이의 유일한 대화 —
 * 짧게 잘라서 상대 프롬프트에 붙이므로 조율 비용이 수백 토큰 이하로 유지된다.
 */
export function extractHandoff(answer: string): string {
  const t = answer.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  // 한 차례에 쓴 글을 모으면 인계가 여러 번 나올 수 있다 → 마지막 인계부터
  const heads = [...t.matchAll(/(?:^|\n)#{1,4}\s*인계[^\n]*\n/g)];
  const last = heads[heads.length - 1];
  const inline = last ? null : t.match(/(?:^|\n)\**인계\**\s*[:：]\s*([\s\S]*)$/);
  const body = (last ? t.slice(last.index! + last[0].length) : inline ? inline[1] : t.split("\n").slice(-6).join("\n")).trim();
  return body.length > MEMO_MAX ? body.slice(0, MEMO_MAX) + "…" : body;
}

function sides(me: Agent, roles: Roles) {
  const myRole: Role = roles.back === me ? "back" : "front";
  const otherRole: Role = myRole === "back" ? "front" : "back";
  return { myRole, otherRole, otherName: me === "claude" ? "Codex" : "Claude" };
}

/** 역할·영역 전체 안내(그 대화에 처음 보낼 때, 역할이 바뀌었을 때, 압축 뒤에만) */
export function roleIntro(me: Agent, roles: Roles, areas: Areas): string {
  const { myRole, otherRole, otherName } = sides(me, roles);
  return `[2인 협업 모드] 너는 ${ROLE_LABEL[myRole]} 담당이다. ${ROLE_LABEL[otherRole]}은 ${otherName} 담당이다.
- 내 영역(우선): ${areas[myRole].join(", ")}
- ${otherName} 영역(수정 금지 — 필요하면 인계에 요청으로 적기): ${areas[otherRole].join(", ")}${me === "codex" ? `\n- ${CODEX_PATCH_RULE}` : ""}
- 이 안내는 대화 처음에 한 번만 온다. 이후 지시에도 계속 지켜라.`;
}

/** 역할·영역이 같은지 비교하는 키(바뀌면 전체 안내를 다시 보낸다) */
export const roleKey = (roles: Roles, areas: Areas) => JSON.stringify([roles.back, roles.front, areas.front, areas.back]);

/**
 * 에이전트에게 보낼 지시. full이면 전체 안내(roleIntro)를 앞에 붙이고,
 * 아니면 대화 기록에 같은 안내가 쌓이지 않게 "상대 영역 수정 금지" 한 줄만 붙인다.
 */
export function rolePrompt(opts: {
  me: Agent;
  roles: Roles;
  areas: Areas;
  instruction: string;
  /** 상대가 남긴 인계 메모(이번 턴 또는 지난 턴) */
  memo?: string;
  /** 이번 지시를 둘이 나눠 하는지(혼자면 상대 영역 안내만) */
  both: boolean;
  /** 전체 안내를 붙일지(기본 true) */
  full?: boolean;
}): string {
  const { myRole, otherRole, otherName } = sides(opts.me, opts.roles);
  const both = !opts.both
    ? ""
    : opts.full === false
      ? `- ${otherName}도 동시에 작업 중 — 내 몫(${ROLE_LABEL[myRole]})만. 상대 결과가 필요하면 기다리지 말고 가정하거나 다른 부분 먼저. 내 몫이 없으면 파일을 열지 말고 "내 몫 없음" 한 줄로 끝.\n`
      : `- ${otherName}도 동시에 작업한다. 내 몫(${ROLE_LABEL[myRole]})만 하라. ${otherName}의 결과가 필요하면 기다리지 말고 형식(함수·API·데이터)을 정해 가정하고 진행하거나 다른 부분을 먼저 하라.\n- 이 지시에 내 담당 쪽 할 일이 없으면 파일을 열어 보지 말고 "내 몫 없음" 한 줄로 바로 끝내라.\n`;
  const memo = opts.memo ? `\n[${otherName}의 인계 메모]\n${opts.memo}\n` : "";
  if (opts.full === false) {
    return `[2인 협업 · ${ROLE_LABEL[myRole]} 담당] ${otherName} 영역(${opts.areas[otherRole].join(", ")})은 수정 금지.
${both}${memo}
[사용자 지시]
${opts.instruction}

(끝에 "### 인계" 5줄 이내, ${otherName}가 할 일은 "요청:" 줄로, 없으면 "없음")`;
  }
  return `${roleIntro(opts.me, opts.roles, opts.areas)}
${both}${memo}
[사용자 지시]
${opts.instruction}

끝나면 답변 맨 끝에 "### 인계" 제목 아래 ${otherName}가 알아야 할 것(API·데이터 형식·바뀐 파일)을 5줄 이내로 적어라. ${otherName}가 해 줘야 할 일은 "요청: …" 줄로 적어라. 없으면 "없음".`;
}
