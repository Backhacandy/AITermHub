// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { detect, nextStep, canContinue, restartHint, loginLabel, CHECK_NAMES, type CliStatus } from "./onboarding";
import { CLI_AGENTS } from "./agents/registry";

const none = async (names: string[]) => names.map(() => null);
const NONE: CliStatus = { claude: "missing", codex: "missing", others: [] };

describe("첫 실행 안내", () => {
  it("Claude·Codex·다른 AI까지 한 번에 찾는다", () => {
    expect(CHECK_NAMES.slice(0, 2)).toEqual(["claude", "codex"]);
    for (const a of CLI_AGENTS) expect(CHECK_NAMES).toContain(a.cmd);
  });
  it("아무것도 없으면 설치 안내부터", async () => {
    const s = await detect(none);
    expect(s).toEqual(NONE);
    expect(nextStep(s)).toBe("install");
  });
  it("Claude만 있어도 쓸 수 있다", async () => {
    const s = await detect(async (n) => n.map((x) => (x === "claude" ? "C:/npm/claude.cmd" : null)));
    expect(nextStep(s)).toBe("ready");
  });
  it("Codex만 있어도 쓸 수 있다", async () => {
    const s = await detect(async (n) => n.map((x) => (x === "codex" ? "C:/npm/codex.cmd" : null)));
    expect(s.codex).toBe("installed");
    expect(nextStep(s)).toBe("ready");
  });
  it("Gemini만 있어도 쓸 수 있다(다른 AI는 id로)", async () => {
    const s = await detect(async (n) => n.map((x) => (x === "gemini" ? "C:/npm/gemini.cmd" : null)));
    expect(s.others).toEqual(["gemini"]);
    expect(nextStep(s)).toBe("ready");
  });
  it("찾다가 오류가 나면 없는 것으로 본다", async () => {
    const s = await detect(async () => {
      throw new Error("x");
    });
    expect(s).toEqual(NONE);
  });
});

describe("로그인 표시(CLI에게 직접 물어본 결과)", () => {
  it("로그인됨 · 로그인 필요 · 확인 중 · 확인 못 함", () => {
    expect(loginLabel(true)).toBe("로그인됨");
    expect(loginLabel(false)).toMatch(/로그인 필요/);
    expect(loginLabel(undefined)).toMatch(/확인 중/);
    expect(loginLabel(null)).toBe("설치됨");
  });
});

describe("첫 실행 안내에서 갇히지 않기", () => {
  it("CLI가 없어도 건너뛰고 앱을 쓸 수 있다(터미널만 쓰는 사람)", () => {
    expect(canContinue(NONE)).toBe(true);
  });
  it("방금 설치했는데 안 보이면 앱을 다시 켜라고 알려 준다(PATH는 앱 시작 때 읽음)", () => {
    expect(restartHint(NONE)).toMatch(/다시 켜/);
    expect(restartHint({ ...NONE, claude: "installed" })).toBe("");
    expect(restartHint({ ...NONE, others: ["gemini"] })).toBe("");
  });
});
