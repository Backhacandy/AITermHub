// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { COST, KEEP, CODEX_FLOOR, compactCost, turnWaste, createMeter, observe, compacted, shouldCompact, codexCompactLimit } from "./compactPolicy";

describe("compactPolicy", () => {
  it("작은 대화는 비용이 쌓이지 않는다", () => {
    expect(turnWaste(KEEP, 1_000_000, 0, 1.25)).toBe(0);
    const m = createMeter(20_000);
    observe(m, 25_000, 500_000, 2_000);
    expect(shouldCompact(m, 200_000, COST)).toBe(false);
  });

  it("다시 읽는 비용이 압축 비용을 넘으면 압축한다", () => {
    const m = createMeter();
    const ctx = 130_000;
    // 턴마다 20번 호출 → 캐시 읽기 20×ctx, 새 입력은 조금
    observe(m, ctx, 20 * ctx, 3_000);
    // 1턴: 0.1×2.6M×(100k/130k) = 200k > 압축 비용(13k+40k+37.5k=90.5k)
    expect(m.waste).toBeGreaterThan(compactCost(ctx));
    expect(shouldCompact(m, 1_000_000, COST)).toBe(true);
  });

  it("호출이 적으면 몇 턴 쌓인 뒤에 압축한다", () => {
    const m = createMeter();
    const ctx = 100_000;
    observe(m, ctx, 2 * ctx, 1_000); // 0.1×200k×0.7 = 14k
    expect(shouldCompact(m, 1_000_000, COST)).toBe(false);
    for (let i = 0; i < 6; i++) observe(m, ctx, 2 * ctx, 1_000);
    expect(shouldCompact(m, 1_000_000, COST)).toBe(true);
  });

  it("재시작 뒤 대화 전체를 캐시에 다시 쓴 것도 비용으로 센다", () => {
    const m = createMeter(180_000);
    observe(m, 181_000, 0, 181_000);
    // 1.25×(181k−30k) ≈ 189k > 압축 비용 ≈ 96k
    expect(shouldCompact(m, 1_000_000, COST)).toBe(true);
  });

  it("재시작 직후(아직 아무 턴도 안 함)에는 압축하지 않는다", () => {
    const m = createMeter(180_000);
    expect(shouldCompact(m, 1_000_000, COST)).toBe(false);
  });

  it("문맥이 크게 줄면(압축됨) 누적을 비운다", () => {
    const m = createMeter();
    observe(m, 150_000, 3_000_000, 0);
    expect(m.waste).toBeGreaterThan(0);
    observe(m, 40_000, 0, 0);
    expect(m.waste).toBe(0);
    compacted(m, 35_000);
    expect(m.ctx).toBe(35_000);
  });

  it("창이 거의 차면 비용과 관계없이 압축", () => {
    const m = createMeter(175_000);
    expect(shouldCompact(m, 200_000, COST)).toBe(true);
  });

  it("끔·% 설정", () => {
    const m = createMeter(130_000);
    m.waste = 1e9;
    expect(shouldCompact(m, 200_000, 0)).toBe(false);
    expect(shouldCompact(m, 200_000, 60)).toBe(true);
    expect(shouldCompact(m, 200_000, 70)).toBe(false);
  });

  it("% 설정은 창이 커도 20만 기준(1M 창에서 60% = 12만, 60만이 아니라)", () => {
    const m = createMeter(130_000);
    expect(shouldCompact(m, 1_000_000, 60)).toBe(true);
    m.ctx = 110_000;
    expect(shouldCompact(m, 1_000_000, 60)).toBe(false);
    expect(codexCompactLimit(m, 1_000_000, 60)).toBe(120_000);
  });

  it("Codex 한도: 때가 되면 지금 문맥보다 낮게, 아니면 창의 85%", () => {
    const m = createMeter(200_000);
    expect(codexCompactLimit(m, 272_000, COST)).toBe(Math.round(272_000 * 0.85));
    m.waste = 1e9;
    expect(codexCompactLimit(m, 272_000, COST)).toBe(180_000);
    expect(codexCompactLimit(m, 272_000, 0)).toBeNull();
    expect(codexCompactLimit(m, 272_000, 60)).toBe(120_000);
  });

  // Codex는 한 차례(몇 시간이 될 수도 있음) 내내 같은 한도로 스스로 압축한다. 압축해도 남는 문맥(지시문·도구·요약 등 3.7만~6.8만)보다
  // 한도가 낮으면 압축 직후 바로 다시 넘어서, 도구를 한 번 쓸 때마다 압축만 되풀이한다(실제로 3.5시간에 133번)
  it("Codex 한도는 압축 뒤 남는 문맥보다 낮아지지 않는다", () => {
    const m = createMeter(81_000);
    m.waste = 1e9;
    expect(codexCompactLimit(m, 272_000, COST)).toBe(CODEX_FLOOR);
    expect(codexCompactLimit(m, 272_000, 20)).toBe(CODEX_FLOOR); // 20% = 4만이어도
    // 창이 바닥보다 작으면 창의 85%까지만
    expect(codexCompactLimit(m, 100_000, COST)).toBe(85_000);
  });
});
