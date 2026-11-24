// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 협업 탭 레인별 모델 선택지와 "자동" 규칙(로컬 판단 — 토큰 0).

import type { Agent } from "./route";
import { MODELS, addCodexModels, codexParts } from "$lib/collab/catalog";

export const AUTO = "auto";

/** 같은 등급이면 새 버전 먼저(Codex), 그다음 카탈로그 순 */
const ver = (id: string) => codexParts(id)?.version ?? 0;
/** 모델 목록은 카탈로그(collab/catalog) 한 곳에서: 자동 + 그 CLI의 모델을 등급 높은 순 */
const laneList = (cli: Agent) => [
  { id: AUTO, label: "자동" },
  ...Object.values(MODELS)
    .filter((m) => m.cli === cli)
    .sort((a, b) => b.tier - a.tier || ver(b.id) - ver(a.id))
    .map((m) => ({ id: m.id, label: m.label })),
];

export const LANE_MODELS: Record<Agent, { id: string; label: string }[]> = {
  claude: laneList("claude"),
  codex: laneList("codex"),
};

/** 그 등급에서 가장 새 모델(목록 순서가 이미 새 버전 먼저) */
const newest = (cli: Agent, tier: number) => LANE_MODELS[cli].find((m) => MODELS[m.id]?.tier === tier)?.id;

/**
 * Codex가 받아 둔 모델 목록을 배운다(앱 시작 때). 새 모델이 있으면 목록·자동 추천이 그 모델로 바뀐다.
 * 사용자가 직접 고른 모델은 그대로 — 바꿀지는 팀장이 일마다 판단한다(role의 model)
 */
export function learnCodexModels(list: { slug: string; label: string }[]): boolean {
  if (!addCodexModels(list)) return false;
  LANE_MODELS.codex.splice(0, LANE_MODELS.codex.length, ...laneList("codex"));
  return true;
}

/** 이름표 바꾸기(카탈로그와 레인 선택지 모두). 모르는 모델이거나 같으면 false */
export function setModelLabel(key: string, label: string): boolean {
  const info = MODELS[key];
  if (!info || info.label === label) return false;
  info.label = label;
  for (const m of LANE_MODELS[info.cli as Agent] ?? []) if (m.id === key) m.label = label;
  return true;
}

const TOP_ = (cli: Agent) => (cli === "claude" ? "opus" : newest("codex", 5) ?? "gpt-6.2-astra");
const MID_ = (cli: Agent) => (cli === "claude" ? "sonnet" : newest("codex", 3) ?? "gpt-6.2-sol");

/** 손이 덜 가는 단순 작업을 가리키는 말 */
const SIMPLE = ["오타", "문구", "텍스트만", "이름 바꿔", "이름 변경", "rename", "색", "컬러", "주석", "간격", "여백", "들여쓰기", "포맷", "typo", "정렬만", "아이콘 바꿔"];
/** 판단이 큰 작업 — 단순 키워드가 있어도 최상위로 */
const HEAVY = ["설계", "아키텍처", "리팩터", "전체", "구조", "마이그레이션", "보안", "성능", "새로 만들", "구현", "버그", "원인"];

/**
 * 자동: 짧고 단순한 지시만 중간 등급, 나머지는 최상위. 품질 우선이라 최하위 등급은 자동으로 고르지 않는다.
 */
export function autoModel(cli: Agent, text: string): string {
  const t = text.toLowerCase();
  const simple = t.length <= 120 && SIMPLE.some((w) => t.includes(w)) && !HEAVY.some((w) => t.includes(w));
  return simple ? MID_(cli) : TOP_(cli);
}

/**
 * 레인 설정값(자동 또는 고정) → 이번 지시에 넘길 모델 인자.
 * 자동에서 최상위로 판단되면 null(= CLI에 설정된 기본 모델 — 사용자가 고른 1M 컨텍스트 등 그대로 유지).
 */
export function laneModel(cli: Agent, setting: string | undefined, text: string): string | null {
  if (setting && setting !== AUTO) return setting;
  const m = autoModel(cli, text);
  return m === TOP_(cli) ? null : m;
}

export const modelLabel = (cli: Agent, id: string | null): string =>
  id ? LANE_MODELS[cli].find((m) => m.id === id)?.label ?? id : "기본 모델";

/** 생각 깊이 선택지("" = 설정 파일 값). Rust util::CLAUDE_EFFORTS / CODEX_EFFORTS와 같아야 한다 */
export const EFFORTS: Record<Agent, { id: string; label: string }[]> = {
  claude: [
    { id: "", label: "생각 기본" },
    { id: "low", label: "생각 낮음" },
    { id: "medium", label: "생각 중간" },
    { id: "high", label: "생각 높음" },
    { id: "xhigh", label: "생각 매우 높음" },
    { id: "max", label: "생각 최대" },
  ],
  codex: [
    { id: "", label: "생각 기본" },
    { id: "low", label: "생각 낮음" },
    { id: "medium", label: "생각 중간" },
    { id: "high", label: "생각 높음" },
  ],
};

export const effortLabel = (cli: Agent, id: string | undefined): string =>
  EFFORTS[cli].find((e) => e.id === (id ?? ""))?.label ?? id ?? "생각 기본";

/** 팀장·분배에 주는 모델 고르기 안내 — Codex는 계열마다 가장 새 모델을 이름으로 알려 준다 */
export function modelGuide(): string {
  const c = (t: number) => newest("codex", t);
  const codex = [c(5) && `${c(5)}: 어려운 백엔드·알고리즘`, c(3) && `${c(3)}: 일반 구현`, c(2) && `${c(2)}: 가벼운 구현`, c(1) && `${c(1)}: 단순·반복`].filter(Boolean).join(" / ");
  return `- cli: 결과물이 더 좋을 쪽으로 — claude는 글·기획·화면·디자인 판단·리뷰에, codex는 백엔드·알고리즘·까다로운 로직·대량 코드 수정에 강하다. 어느 쪽이 나을지 애매하면 지금 팀에서 결과가 좋았던 쪽을 따른다
- model: 맡을 일의 난이도로 고른다(auto는 쓰지 않는다)
  · claude — fable·opus: 설계·어려운 디버깅·큰 리팩터링 / sonnet: 일반 구현·화면·테스트 / haiku: 문서·단순 반복
  · codex — ${codex} (같은 계열이면 가장 새 버전을 쓴다. 옛 버전은 일부러 고를 까닭이 있을 때만)
- effort: 생각 깊이 — claude는 low·medium·high·xhigh·max, codex는 low·medium·high. 단순하면 low~medium, 일반 구현은 high, 설계·까다로운 문제만 xhigh 이상`;
}
