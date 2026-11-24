// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { hasRequest, followups, followupLimit, isNoShare } from "./rounds";

describe("동시 작업 뒤 후속", () => {
  it("인계에 '요청:' 줄이 있어야 요청으로 본다", () => {
    expect(hasRequest("- POST /pay 추가함\n- 요청: 결제 버튼에서 /pay 호출해 줘")).toBe(true);
    expect(hasRequest("요청 : 응답에 total 필드 넣어 줘")).toBe(true);
    expect(hasRequest("- 바뀐 파일: api.rs\n- 프론트에 요청할 건 없음")).toBe(false);
    expect(hasRequest("없음")).toBe(false);
    expect(hasRequest("")).toBe(false);
  });
  it("요청을 받은 쪽만, 최대 3번까지 이어서", () => {
    const memos = { claude: "요청: 버튼 연결", codex: "바뀐 파일: ui.svelte" };
    expect(followups(memos, 0, ["codex", "claude"])).toEqual(["claude"]);
    expect(followups({ claude: "요청: a", codex: "요청: b" }, 0, ["codex", "claude"])).toEqual(["codex", "claude"]);
    expect(followups(memos, 2, ["codex", "claude"])).toEqual(["claude"]);
    expect(followups(memos, 3, ["codex", "claude"])).toEqual([]);
    // 이번 지시에 없던 쪽은 "요청: @이름"으로 콕 집혔을 때만 깨운다
    expect(followups(memos, 0, ["codex"])).toEqual([]);
    expect(followups(memos, 0, ["codex"], ["claude"])).toEqual(["claude"]);
  });
});

describe("후속 횟수 설정", () => {
  const memos = { claude: "요청: 버튼 연결" };
  it("정한 횟수까지, 무제한이면 끝없이", () => {
    expect(followups(memos, 5, ["claude"], [], 6)).toEqual(["claude"]);
    expect(followups(memos, 6, ["claude"], [], 6)).toEqual([]);
    expect(followups(memos, 999, ["claude"], [], followupLimit({ followupUnlimited: true }))).toEqual(["claude"]);
  });
  it("설정값: 기본 3, 0 이상 정수로, 무제한이면 Infinity", () => {
    expect(followupLimit({})).toBe(3);
    expect(followupLimit({ followupMax: 10 })).toBe(10);
    expect(followupLimit({ followupMax: 2.7 })).toBe(2);
    expect(followupLimit({ followupMax: -1 })).toBe(0);
    expect(followupLimit({ followupMax: 10, followupUnlimited: true })).toBe(Infinity);
  });
});

describe("할 일 없는 쪽", () => {
  it("'내 몫 없음' 답은 인계로 넘기지 않는다", () => {
    expect(isNoShare("내 몫 없음")).toBe(true);
    expect(isNoShare("  내 몫 없음.\n")).toBe(true);
    expect(isNoShare("내 몫 없음 — 프론트만 바뀌는 지시예요")).toBe(true);
    expect(isNoShare("API 추가했어요\n### 인계\n없음")).toBe(false);
  });
});

import { scopeLimited } from "./rounds";
describe("범위를 정한 지시", () => {
  it("'~만·~까지만·하지 마·아직 개발하지 마'면 범위 제한", () => {
    for (const t of ["기획서까지만 작성하라", "기획만 해줘", "분석만 하고 코드는 건드리지 마", "아직 개발하지 마", "구현은 하지 말고 설계만", "문서만 정리해"]) expect(scopeLimited(t), t).toBe(true);
    for (const t of ["결제 기능 만들어줘", "이어서 진행해", "테스트까지 끝내고 배포해", "만약 오류가 나면 고쳐줘"]) expect(scopeLimited(t), t).toBe(false);
  });
});
