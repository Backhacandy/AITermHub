// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { detect, nextStep } from "./onboarding";

describe("첫 실행 안내", () => {
  it("Claude·Codex 둘 다 없으면 설치 안내부터", async () => {
    const s = await detect(async () => [null, null]);
    expect(s).toEqual({ claude: "missing", codex: "missing" });
    expect(nextStep(s)).toBe("install");
  });
  it("Claude만 있어도 쓸 수 있다", async () => {
    const s = await detect(async () => ["C:\npm\claude.cmd", null]);
    expect(nextStep(s)).toBe("ready");
  });
  it("찾다가 오류가 나면 없는 것으로 본다", async () => {
    const s = await detect(async () => {
      throw new Error("x");
    });
    expect(s).toEqual({ claude: "missing", codex: "missing" });
  });
});

import { canContinue, restartHint } from "./onboarding";
describe("첫 실행 안내에서 갇히지 않기", () => {
  it("CLI가 없어도 건너뛰고 앱을 쓸 수 있다(터미널·다른 에이전트만 쓰는 사람)", () => {
    expect(canContinue({ claude: "missing", codex: "missing" })).toBe(true);
  });
  it("방금 설치했는데 안 보이면 앱을 다시 켜라고 알려 준다(PATH는 앱 시작 때 읽음)", () => {
    expect(restartHint({ claude: "missing", codex: "missing" })).toMatch(/다시 켜/);
    expect(restartHint({ claude: "installed", codex: "missing" })).toBe("");
  });
});
