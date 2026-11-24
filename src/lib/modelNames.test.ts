// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "settings_get" ? { modelNames: { opus: "Opus 6" } } : undefined)) }));
import { nameFromId, MODELS } from "$lib/collab/catalog";
import { LANE_MODELS, modelLabel } from "$lib/pair/models";
import { settings, learnModel, loadSettings } from "$lib/settings.svelte";

describe("모델 이름표 — Claude가 알려 준 실제 버전으로", () => {
  it("실제 모델 이름에서 별칭과 이름표를 읽는다", () => {
    expect(nameFromId("claude-sonnet-5-5")).toEqual({ key: "sonnet", label: "Sonnet 5.5" });
    expect(nameFromId("claude-opus-5-5[1m]")).toEqual({ key: "opus", label: "Opus 5.5" });
    expect(nameFromId("claude-haiku-4-5-20251001")).toEqual({ key: "haiku", label: "Haiku 4.5" });
    expect(nameFromId("claude-sonnet-6")).toEqual({ key: "sonnet", label: "Sonnet 6" });
    expect(nameFromId("claude-3-5-sonnet-20241022")).toBeNull();
    expect(nameFromId("gpt-6.1-sol")).toBeNull();
  });

  it("별칭으로 불렀을 때만 이름표·선택지를 바꾸고 기억한다", () => {
    learnModel("sonnet", "claude-sonnet-6-1");
    expect(MODELS.sonnet.label).toBe("Sonnet 6.1");
    expect(modelLabel("claude", "sonnet")).toBe("Sonnet 6.1");
    expect(LANE_MODELS.claude.find((m) => m.id === "sonnet")?.label).toBe("Sonnet 6.1");
    expect(settings.modelNames?.sonnet).toBe("Sonnet 6.1");
    // 기본 모델(null)이나 다른 별칭으로 부른 경우는 그대로
    learnModel(null, "claude-haiku-9");
    learnModel("opus", "claude-haiku-9");
    expect(MODELS.haiku.label).toBe("Haiku 5.5");
  });

  it("켤 때 기억해 둔 이름표를 다시 씌운다", async () => {
    await loadSettings();
    expect(MODELS.opus.label).toBe("Opus 6");
  });
});
