// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { STORAGE_DEFAULTS as D, diskLevel, driveOf } from "./storagePolicy";

describe("storagePolicy", () => {
  it("남은 공간으로 단계를 정한다(10GB 경보, 3GB 멈춤)", () => {
    expect(diskLevel(12, false, D)).toBe("ok");
    expect(diskLevel(9.9, false, D)).toBe("warn");
    expect(diskLevel(2.9, false, D)).toBe("stop");
  });

  // 멈춘 뒤 3GB 경계에서 멈춤·풀림이 되풀이되지 않게 5GB를 넘어야 푼다
  it("hysteresis: 멈춘 뒤에는 5GB를 넘어야 푼다", () => {
    expect(diskLevel(4, true, D)).toBe("stop");
    expect(diskLevel(5.1, true, D)).toBe("warn");
    expect(diskLevel(11, true, D)).toBe("ok");
  });

  it("경로의 드라이브(대문자)", () => {
    expect(driveOf("c:\\MyNovel")).toBe("C:");
    expect(driveOf("D:/x")).toBe("D:");
    expect(driveOf("relative")).toBe("");
  });

  it("기본값", () => {
    expect(D).toEqual({ cleanHours: 6, dirtyHours: 24, tmpHours: 6, codexHours: 6, claudeDays: 14, warnGB: 10, stopGB: 3, resumeGB: 5 });
  });
});
