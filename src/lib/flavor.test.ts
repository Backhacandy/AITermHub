// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi, afterEach } from "vitest";
import { flavor, multiAccount } from "./flavor";

afterEach(() => vi.unstubAllEnvs());

describe("판(flavor)", () => {
  it("VITE_FLAVOR가 없으면 개발판 — 계정 여러 개 있음", () => {
    vi.stubEnv("VITE_FLAVOR", "");
    expect(flavor()).toBe("dev");
    expect(multiAccount()).toBe(true);
  });
  it("release면 배포판 — 계정 여러 개 없음", () => {
    vi.stubEnv("VITE_FLAVOR", "release");
    expect(flavor()).toBe("release");
    expect(multiAccount()).toBe(false);
  });
});
