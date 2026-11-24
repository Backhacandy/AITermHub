// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { LANE_MODELS, autoModel, learnCodexModels, modelGuide } from "./models";
import { MODELS } from "$lib/collab/catalog";

describe("모델 목록", () => {
  it("팀·단일 모델 목록은 카탈로그 한 곳에서 나온다(같은 등급은 새 버전 먼저)", () => {
    expect(LANE_MODELS.claude.map((m) => m.id)).toEqual(["auto", "opus", "fable", "sonnet", "haiku"]);
    expect(LANE_MODELS.codex.map((m) => m.id)).toEqual(["auto", "gpt-6.2-astra", "gpt-6-astra", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(LANE_MODELS.claude.find((m) => m.id === "fable")?.label).toBe("Fable 5.2");
  });

  it("코덱스 기본 추천은 가장 새 버전(6.2)", () => {
    expect(autoModel("codex", "로그인 화면을 새로 만들어 줘")).toBe("gpt-6.2-astra");
    expect(autoModel("codex", "오타 고쳐 줘")).toBe("gpt-6.2-sol");
  });

  // 목록을 코드에 적어 두어 GPT-6.2가 나와도 안 보였다 → Codex가 받아 둔 목록을 따른다
  it("Codex가 아는 모델을 배우면 목록·추천이 저절로 따라간다", () => {
    const changed = learnCodexModels([
      { slug: "gpt-6.3-sol", label: "GPT-6.3-Sol" },
      { slug: "gpt-6.3-astra", label: "GPT-6.3-Astra" },
      { slug: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
      { slug: "codex-auto-review", label: "Codex Auto Review" },
    ]);
    expect(changed).toBe(true);
    expect(MODELS["gpt-6.3-astra"]).toMatchObject({ cli: "codex", tier: 5, label: "GPT-6.3 Astra" });
    expect(MODELS["gpt-6.1-terra"]?.tier).toBe(2);
    expect(MODELS["codex-auto-review"]).toBeUndefined();
    expect(LANE_MODELS.codex.map((m) => m.id).slice(0, 3)).toEqual(["auto", "gpt-6.3-astra", "gpt-6.2-astra"]);
    expect(autoModel("codex", "로그인 화면을 새로 만들어 줘")).toBe("gpt-6.3-astra");
    expect(autoModel("codex", "오타 고쳐 줘")).toBe("gpt-6.3-sol");
    expect(modelGuide()).toContain("gpt-6.3-astra");
    expect(modelGuide()).toContain("gpt-6.3-sol");
    expect(learnCodexModels([{ slug: "gpt-6.3-sol", label: "GPT-6.3-Sol" }])).toBe(false); // 이미 앎
  });
});
