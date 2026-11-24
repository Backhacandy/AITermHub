// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { LANE_MODELS } from "$lib/pair/models";
// 팀 운영 방식: 라이트(토큰 아끼기) · 맥스(품질·속도). 같은 기능에서 팀장 모델·인원 상한·모델 등급·Chrome·검증만 다르다.

import { MODELS } from "$lib/collab/catalog";

export type TeamMode = "lite" | "max";

export interface ModeProfile {
  leadModel: string;
  leadEffort: string;
  /** 팀장을 뺀 인원 상한(Infinity = 제한 없음) */
  cap: number;
  /** 에이전트에게 쓸 수 있는 모델 등급 상한(1~5) */
  maxTier: number;
  /** 브라우저(Claude in Chrome)를 쓸 수 있는지 — 맥스에서도 팀장이 chrome:true로 만든 역할만 */
  chrome: boolean;
  /** 합치기 전 검증 담당(QA)이 테스트·확인 */
  verify: boolean;
  label: string;
}

export const MODES: Record<TeamMode, ModeProfile> = {
  lite: { leadModel: "sonnet", leadEffort: "medium", cap: 4, maxTier: 3, chrome: false, verify: false, label: "라이트" },
  max: { leadModel: "opus", leadEffort: "high", cap: Infinity, maxTier: 5, chrome: true, verify: true, label: "맥스" },
};

/** 팀의 운영 방식(팀장 멤버에 저장). 운영 방식이 없던 옛 팀은 맥스 — 지금까지의 동작 그대로 */
export const teamMode = (lead: { mode?: TeamMode } | undefined): TeamMode => lead?.mode ?? "max";

/** 등급을 넘는 모델은 그 CLI에서 허용 등급 이하 중 가장 높은 모델로. 등급 제한이 있으면 auto도 그 모델로 고정한다
 *  (auto는 지시마다 최상위 모델을 고르므로 라이트에서 새어 나간다). 모르는 모델은 그대로 */
export function clampModel(cli: "claude" | "codex", model: string, maxTier: number): string {
  // 목록은 등급 높은 순 · 같은 등급은 새 버전 먼저 — 허용 등급 중 가장 높고 가장 새 모델
  const top = () => LANE_MODELS[cli].find((x) => x.id !== "auto" && (MODELS[x.id]?.tier ?? 99) <= maxTier)?.id;
  if (model === "auto") return maxTier < 5 ? (top() ?? model) : model;
  const m = MODELS[model];
  if (!m || m.tier <= maxTier) return model;
  return top() ?? model;
}

/**
 * 운영 방식을 바꿀 때 에이전트 모델: 등급을 넘으면 낮추고 원래 모델(maxModel)을 기억한다.
 * 기억한 모델이 있으면 그걸 기준으로 다시 맞춘다 — 맥스로 돌아오면 원래 모델로 되돌아간다
 */
export function modelForMode(cli: "claude" | "codex", model: string, maxModel: string | undefined, maxTier: number): { model: string; maxModel?: string } {
  const want = maxModel ?? model;
  const nm = clampModel(cli, want, maxTier);
  return nm === want ? { model: want } : { model: nm, maxModel: want };
}

/** 바꿀 수 있는 방향: 라이트 → 맥스만(맥스로 만들었거나 맥스로 바꾼 팀은 라이트로 돌아가지 않는다) */
export const canSwitchMode = (from: TeamMode, to: TeamMode): boolean => from === "lite" && to === "max";

/** 대화 기록의 실제 모델 이름(claude-opus-5-5, gpt-6-astra 등) → 목록의 모델 id. 모르면 null */
export function catalogModel(cli: "claude" | "codex", used: string): string | null {
  const u = used.toLowerCase();
  if (MODELS[u]?.cli === cli) return u;
  if (cli === "claude") return ["opus", "fable", "sonnet", "haiku"].find((k) => u.includes(k)) ?? null;
  return Object.keys(MODELS).find((k) => MODELS[k].cli === "codex" && u.startsWith(k)) ?? null;
}

/**
 * 예전에 라이트로 낮아진 모델 되돌리기(원래 모델 기록이 없던 팀): used = 라이트로 바꾸기 전 마지막으로 쓴 모델.
 * 지금보다 높은 등급이었으면 맥스는 바로 그 모델로, 라이트는 기억만(맥스로 바꾸면 되돌린다). 아니면 null
 */
export function recoverModel(cli: "claude" | "codex", current: string, used: string | null, mode: TeamMode): { model?: string; maxModel?: string } | null {
  const id = used ? catalogModel(cli, used) : null;
  if (!id || current === "auto") return null;
  const was = MODELS[id]?.tier ?? 0;
  const now = MODELS[current]?.tier ?? 0;
  if (was <= now) return null;
  return mode === "max" ? { model: id } : { maxModel: id };
}

/** 팀장 프롬프트에 넣을 운영 방식 규칙 */
export function modeRules(mode: TeamMode): string {
  return mode === "lite"
    ? `토큰을 아끼는 팀이다. 인원은 꼭 필요한 만큼만(최대 ${MODES.lite.cap}명), Opus·Fable·Astra 같은 최상위 모델은 쓰지 않고, 생각 수준은 낮음~중간. 검증은 팀장이 바뀐 내용(git diff)을 읽어 한 번 한다. 브라우저 도구는 쓰지 않는다.`
    : "품질과 속도가 우선인 팀이다. 나눌 수 있는 일은 병렬로 맡기고, 어려운 일은 최상위 모델(claude는 Opus·Fable, codex는 가장 새 Astra)과 높은 생각 수준을 쓴다. claude와 codex 중에는 습관이나 익숙함이 아니라 그 일의 결과물이 더 좋을 쪽을 고른다 — 같은 팀 안에서 섞어 써도 되고, 한쪽이 막히거나 결과가 아쉬우면 다른 쪽에 맡겨 본다. 합치기(merge) 전에는 검증 담당(QA)에게 테스트·확인을 맡기고 통과해야 합친다. 화면을 브라우저로 확인해야 하는 역할은 create(또는 role)에 \"chrome\":true를 넣는다.";
}
