// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { matchOwns, ownsOverlap, globToRegex } from "./ownership";

describe("소유권", () => {
  it("glob 매칭", () => {
    expect(matchOwns("src/payment/charge.ts", ["src/payment/**"])).toBe(true);
    expect(matchOwns("src/payment/a/b.ts", ["src/payment/**"])).toBe(true);
    expect(matchOwns("src/paymentx/a.ts", ["src/payment/**"])).toBe(false);
    expect(matchOwns("README.md", ["README.md"])).toBe(true);
    expect(matchOwns("src/a.test.ts", ["src/*.test.ts"])).toBe(true);
    expect(matchOwns("src/x/a.test.ts", ["src/*.test.ts"])).toBe(false);
    expect(matchOwns("SRC\\Payment\\A.ts", ["src/payment/**"])).toBe(true); // Windows 경로·대소문자
    expect(globToRegex("a/**/b").test("a/b")).toBe(true);
  });
  it("겹침은 보수적으로(접두사 기준)", () => {
    expect(ownsOverlap(["src/payment/**"], ["src/payment/charge.ts"])).toBe(true);
    expect(ownsOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(ownsOverlap(["src/**/*.test.ts"], ["src/a/**"])).toBe(true);
    expect(ownsOverlap(["package.json"], ["src/**"])).toBe(false);
  });
});
