// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { normalizeUrl, isLocalUrl } from "./preview";

describe("preview", () => {
  it("주소 정리", () => {
    expect(normalizeUrl("5173")).toBe("http://localhost:5173");
    expect(normalizeUrl(" localhost:3000/a ")).toBe("http://localhost:3000/a");
    expect(normalizeUrl("https://localhost:8443")).toBe("https://localhost:8443");
  });
  it("이 PC 주소만 허용", () => {
    expect(isLocalUrl("http://localhost:5173/x")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalUrl("https://example.com")).toBe(false);
    expect(isLocalUrl("http://localhost.evil.com")).toBe(false);
    expect(isLocalUrl("javascript:alert(1)")).toBe(false);
  });
});
