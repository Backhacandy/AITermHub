// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { ABOUT, EXTERNAL, showSponsor } from "./about";

describe("정보 화면", () => {
  it("외부로 연결하는 기능을 모두 적고, 언제 연결되는지 비워 두지 않는다", () => {
    expect(EXTERNAL.some((e) => e.name.includes("업데이트"))).toBe(true);
    expect(EXTERNAL.every((e) => e.when.trim().length > 0 && e.where.trim().length > 0)).toBe(true);
  });
  it("후원 주소가 없으면 후원 버튼을 보이지 않는다", () => {
    expect(showSponsor({ ...ABOUT, sponsor: "" })).toBe(false);
    expect(showSponsor({ ...ABOUT, sponsor: "https://github.com/sponsors/Backhacandy" })).toBe(true);
  });
  it("만든 사람 표시(라이선스 7조 b항으로 유지를 요구하는 문구)와 인스타 주소", () => {
    expect(ABOUT.credit).toBe("Made by Backhacandy");
    expect(ABOUT.instagram).toBe("https://www.instagram.com/aitermhub/");
    expect(ABOUT.authorInstagram).toBe("https://www.instagram.com/i_dh0101/");
  });
  it("라이선스와 저장소", () => {
    expect(ABOUT.license).toBe("AGPL-3.0-or-later");
    expect(ABOUT.repo).toBe("https://github.com/Backhacandy/AITermHub");
  });
});
