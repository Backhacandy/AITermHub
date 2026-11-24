// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { sessionToSave } from "./sessionPick";

describe("탭에 저장할 Claude 대화 번호", () => {
  it("폴더의 최근 대화로 이어 붙였으면 그 번호를 탭에 저장한다(다음엔 파일 순서와 관계없이 그 대화)", () => {
    expect(sessionToSave("", "499e")).toBe("499e");
    expect(sessionToSave(undefined, "499e")).toBe("499e");
  });
  it("이미 저장된 번호와 같거나 불러온 대화가 없으면 저장할 것 없음", () => {
    expect(sessionToSave("499e", "499e")).toBeNull();
    expect(sessionToSave("", null)).toBeNull();
  });
});
