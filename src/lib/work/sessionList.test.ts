// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { sessionLabel, sessionAgo } from "./sessionList";

describe("대화 고르기 목록", () => {
  it("제목 → 첫 질문(협업 안내문은 빼고) 순으로 이름", () => {
    expect(sessionLabel({ title: "결제 화면", first: "만들어줘" })).toBe("결제 화면");
    expect(sessionLabel({ title: null, first: "[2인 협업 · 백엔드 담당] Claude 영역(x)은 수정 금지.\n\n[사용자 지시]\nAPI 추가\n\n(끝에 \"### 인계\" 5줄 이내, 없으면 \"없음\")" })).toBe("API 추가");
    expect(sessionLabel({ title: null, first: null })).toBe("내용 없음");
  });
  it("언제 쓴 대화인지", () => {
    const now = 1_000_000;
    expect(sessionAgo(now - 30, now)).toBe("방금");
    expect(sessionAgo(now - 5 * 60, now)).toBe("5분 전");
    expect(sessionAgo(now - 3 * 3600, now)).toBe("3시간 전");
    expect(sessionAgo(now - 2 * 86400, now)).toBe("2일 전");
  });
});
