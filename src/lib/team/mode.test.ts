// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { MODES, teamMode, clampModel, modeRules, modelForMode, canSwitchMode, catalogModel, recoverModel } from "./mode";

describe("운영 방식", () => {
  it("라이트·맥스 값", () => {
    expect(MODES.lite).toMatchObject({ leadModel: "sonnet", leadEffort: "medium", cap: 4, maxTier: 3, chrome: false, verify: false, label: "라이트" });
    expect(MODES.max).toMatchObject({ leadModel: "opus", leadEffort: "high", cap: Infinity, maxTier: 5, chrome: true, verify: true, label: "맥스" });
  });
  it("옛 팀(운영 방식 없음)은 맥스 — 지금 동작 그대로", () => {
    expect(teamMode(undefined)).toBe("max");
    expect(teamMode({})).toBe("max");
    expect(teamMode({ mode: "lite" })).toBe("lite");
  });
  it("등급을 넘는 모델은 그 CLI에서 허용 등급 중 가장 높은 것으로", () => {
    expect(clampModel("claude", "opus", 3)).toBe("sonnet");
    expect(clampModel("claude", "fable", 3)).toBe("sonnet");
    expect(clampModel("codex", "gpt-6-astra", 3)).toBe("gpt-6.2-sol");
    expect(clampModel("claude", "haiku", 3)).toBe("haiku");
    expect(clampModel("claude", "opus", 5)).toBe("opus");
  });
  it("팀장에게 줄 운영 방식 규칙", () => {
    expect(modeRules("lite")).toMatch(/토큰/);
    expect(modeRules("max")).toMatch(/검증/);
  });
});

describe("라이트의 자동 모델", () => {
  it("라이트에서 auto는 허용 등급 중 가장 높은 모델로 고정(자동이 최상위로 돌지 않게), 맥스는 그대로", () => {
    expect(clampModel("claude", "auto", 3)).toBe("sonnet");
    expect(clampModel("codex", "auto", 3)).toBe("gpt-6.2-sol");
    expect(clampModel("claude", "auto", 5)).toBe("auto");
  });
});

describe("라이트↔맥스 모델 되돌리기", () => {
  it("라이트로 낮출 때 원래 모델을 기억하고, 맥스로 돌아오면 되돌린다", () => {
    const lite = modelForMode("claude", "opus", undefined, MODES.lite.maxTier);
    expect(lite).toEqual({ model: "sonnet", maxModel: "opus" });
    expect(modelForMode("claude", lite.model, lite.maxModel, MODES.max.maxTier)).toEqual({ model: "opus" });
    // 자동도 그대로 돌아온다
    const auto = modelForMode("codex", "auto", undefined, MODES.lite.maxTier);
    expect(auto).toEqual({ model: "gpt-6.2-sol", maxModel: "auto" });
    expect(modelForMode("codex", auto.model, auto.maxModel, MODES.max.maxTier)).toEqual({ model: "auto" });
  });
  it("낮출 필요가 없으면 기억하지 않고, 라이트를 두 번 눌러도 원래 모델을 잃지 않는다", () => {
    expect(modelForMode("claude", "haiku", undefined, MODES.lite.maxTier)).toEqual({ model: "haiku" });
    expect(modelForMode("claude", "sonnet", "fable", MODES.lite.maxTier)).toEqual({ model: "sonnet", maxModel: "fable" });
  });
});

describe("운영 방식은 라이트 → 맥스로만", () => {
  it("맥스는 라이트로 못 바꾼다", () => {
    expect(canSwitchMode("lite", "max")).toBe(true);
    expect(canSwitchMode("max", "lite")).toBe(false);
    expect(canSwitchMode("max", "max")).toBe(false);
  });
});

describe("예전에 라이트로 낮아진 모델 되돌리기", () => {
  it("대화 기록의 모델 이름을 목록 id로", () => {
    expect(catalogModel("claude", "claude-opus-5-5")).toBe("opus");
    expect(catalogModel("claude", "claude-fable-5-2")).toBe("fable");
    expect(catalogModel("claude", "claude-sonnet-5")).toBe("sonnet");
    expect(catalogModel("codex", "gpt-6-astra")).toBe("gpt-6-astra");
    expect(catalogModel("codex", "gpt-6.2-sol")).toBe("gpt-6.2-sol");
    expect(catalogModel("claude", "gpt-6-astra")).toBeNull();
  });
  it("더 높았으면 맥스는 바로 되돌리고 라이트는 기억만, 같거나 낮으면 그대로", () => {
    expect(recoverModel("claude", "sonnet", "claude-opus-5-5", "max")).toEqual({ model: "opus" });
    expect(recoverModel("claude", "sonnet", "claude-opus-5-5", "lite")).toEqual({ maxModel: "opus" });
    expect(recoverModel("codex", "gpt-6.2-sol", "gpt-6-astra", "max")).toEqual({ model: "gpt-6-astra" });
    expect(recoverModel("claude", "sonnet", "claude-sonnet-5", "max")).toBeNull();
    expect(recoverModel("claude", "opus", "claude-haiku-5-5", "max")).toBeNull();
    expect(recoverModel("claude", "sonnet", null, "max")).toBeNull();
  });
});
