// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 대화 압축(/compact)을 언제 할지 — 토큰 비용 비교로 정한다.
//
// 압축하지 않으면 매 API 호출마다 지난 대화 전체를 다시 읽는다(캐시 읽기).
// 재시작·캐시 만료 뒤 첫 호출은 그 대화 전체를 캐시에 새로 쓴다(더 비쌈).
// 압축하면 한 번: 지금 대화를 읽고, 요약을 쓰고, 줄어든 대화를 캐시에 다시 쓴다.
//
// "압축 안 해서 더 낸 비용"을 턴마다 쌓다가 압축 비용을 넘으면 그때 압축한다.
// 대화가 언제 끝날지 모르는 상황에서 손해를 최대 2배로 묶는 방법(빌릴까 살까 문제).
// 압축으로도 안 줄어드는 기본 문맥(시스템 프롬프트·도구 정의 + 요약)은 KEEP으로 본다.

/** 입력 토큰 1 기준 비용 비율(Anthropic 가격표: 캐시 읽기 0.1배, 캐시 쓰기 1.25배, 출력 5배) */
export const W = { read: 0.1, write: 1.25, out: 5 };
/** 압축 뒤에도 남는 문맥 추정치(토큰) */
export const KEEP = 30_000;
/** 압축 요약본 길이 추정치(토큰, 출력으로 계산) */
export const SUMMARY = 8_000;
/** 비용과 관계없이 이 비율을 넘으면 압축(창이 넘치기 전에) */
export const CEILING = 0.85;

/** % 설정의 기준 창(토큰). 1M 창 모델에서 60%면 60만 토큰까지 지난 대화를 끌고 다녀서, 창이 이보다 커도 이 크기로 본다 */
export const PCT_BASE = 200_000;

/** % 설정이 가리키는 문맥 크기 */
function pctLimit(ctxLimit: number, setting: number): number {
  return Math.round((Math.min(ctxLimit, PCT_BASE) * setting) / 100);
}

/**
 * 팀 에이전트의 자동 압축 창(CLAUDE_CODE_AUTO_COMPACT_WINDOW). 앱의 압축은 지시 사이에만 해서, 긴 일 하나를 하는 동안
 * 1M 창 모델은 50만 토큰 넘게 끌고 다녔다(Luck 그림 담당 둘이 하루 사용량의 18%). 이 크기면 일 도중에도 Claude가 스스로 압축한다.
 * 실측: 3번 압축돼도 처음 받은 규칙·인계 형식·답이 같았고, 72시간 팀원 호출 6만 번 중 3번 안에 13만 넘게 불어난 적이 없어 되풀이 압축(thrashing)도 없다
 */
export const TEAM_COMPACT_WINDOW = PCT_BASE;

/** 설정값: -1 = 비용 비교(자동), 0 = 끔, 1~99 = 문맥이 그 %를 넘으면(창이 20만보다 크면 20만 기준) */
export const COST = -1;

/** 지금 문맥 ctx를 압축하는 데 드는 비용 */
export function compactCost(ctx: number): number {
  return W.read * ctx + W.out * SUMMARY + W.write * KEEP;
}

/**
 * 한 턴(여러 API 호출)에서 압축했다면 아꼈을 비용.
 * read: 턴 동안 캐시에서 읽은 토큰 합, fresh: 캐시 없이 새로 보낸 입력 토큰 합(Claude는 캐시 쓰기 포함),
 * freshW: fresh의 비용 비율(Claude 1.25, Codex 1), ctx: 턴이 끝난 뒤 문맥 크기.
 */
export function turnWaste(ctx: number, read: number, fresh: number, freshW: number): number {
  if (ctx <= KEEP) return 0;
  // 읽은 문맥 중 압축했으면 없었을 몫
  let waste = W.read * read * ((ctx - KEEP) / ctx);
  // 새로 보낸 입력이 문맥의 절반을 넘으면 대화 전체를 캐시에 다시 쓴 것(재시작·캐시 만료) — 압축했으면 KEEP만 썼다
  if (fresh > ctx * 0.5) waste += freshW * Math.max(0, Math.min(fresh, ctx) - KEEP);
  return waste;
}

export interface Meter {
  /** 마지막 압축 이후 압축 안 해서 더 낸 비용 누적 */
  waste: number;
  /** 현재 문맥 크기(토큰) */
  ctx: number;
}

export function createMeter(ctx = 0): Meter {
  return { waste: 0, ctx };
}

/** 턴이 끝나면 문맥 크기와 그 턴의 토큰을 반영. 문맥이 크게 줄었으면(압축됨) 누적을 비운다 */
export function observe(m: Meter, ctx: number, read = 0, fresh = 0, freshW = W.write) {
  if (ctx > 0 && m.ctx > 0 && ctx < m.ctx * 0.6) m.waste = 0;
  if (ctx > 0) m.ctx = ctx;
  m.waste += turnWaste(m.ctx, read, fresh, freshW);
}

/** 압축이 끝났을 때 */
export function compacted(m: Meter, ctx: number) {
  m.waste = 0;
  m.ctx = ctx;
}

/** 다음 지시 전에 압축할지 */
export function shouldCompact(m: Meter, ctxLimit: number, setting: number): boolean {
  if (setting === 0 || m.ctx <= 0 || ctxLimit <= 0) return false;
  if (setting > 0) return m.ctx >= pctLimit(ctxLimit, setting);
  if (m.ctx / ctxLimit >= CEILING) return true;
  return m.ctx > KEEP && m.waste >= compactCost(m.ctx);
}

/**
 * Codex 한도의 바닥(토큰). Codex는 한 차례 내내 같은 한도로 스스로 압축하는데, 압축해도 지시문·도구·요약 등이 3.7만~6.8만 남는다.
 * 한도가 그보다 낮으면 압축 직후 바로 다시 넘어 도구 한 번마다 압축만 되풀이한다(3.5시간에 133번) — 그래서 이 아래로는 주지 않는다
 */
export const CODEX_FLOOR = 120_000;

/**
 * Codex는 스스로 압축한다(model_auto_compact_token_limit). 넘길 한도:
 * 압축할 때가 됐으면 지금 문맥보다 낮게(다음 호출에서 바로 압축), 아니면 창의 CEILING.
 * 어느 쪽이든 CODEX_FLOOR보다 낮게 주지 않는다(창이 작으면 창의 CEILING까지만).
 */
export function codexCompactLimit(m: Meter, ctxLimit: number, setting: number): number | null {
  if (setting === 0) return null;
  const top = Math.round(ctxLimit * CEILING);
  const floor = (n: number) => Math.min(Math.max(n, CODEX_FLOOR), top);
  if (setting > 0) return floor(pctLimit(ctxLimit, setting));
  if (shouldCompact(m, ctxLimit, setting)) return floor(Math.floor(m.ctx * 0.9));
  return top;
}
