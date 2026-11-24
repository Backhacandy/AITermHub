// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ autoSleep: false })) }));

describe("설정 기본값", () => {
  it("새 설치는 터미널 탭 자동 재우기가 켜져 있고, 저장된 값이 있으면 그 값이 이긴다", async () => {
    const { settings, loadSettings } = await import("./settings.svelte");
    expect(settings.autoSleep).toBe(true);
    await loadSettings();
    expect(settings.autoSleep).toBe(false);
  });
});

describe("배포판 기본값", () => {
  it("남의 PC를 건드리는 백그라운드 기능(CLI 자동 업데이트·잔디 올리기)은 배포판에서 기본으로 꺼져 있다", async () => {
    vi.stubEnv("VITE_FLAVOR", "release");
    const { settings, loadSettings } = await import("./settings.svelte");
    delete settings.cliAutoUpdate;
    delete settings.grassOn;
    await loadSettings();
    expect(settings.cliAutoUpdate).toBe(false);
    expect(settings.grassOn).toBe(false);
    vi.unstubAllEnvs();
  });
});
