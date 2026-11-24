// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { normalizeAssign, assignOrAll, normalizeProposal, distributePrompt, proposePrompt } from "./distribute";
import type { Member } from "./team";

const M = (id: string, name: string, areas: string[], cli: "claude" | "codex" = "claude"): Member => ({ id, name, cli, model: "auto", purpose: `${name} 담당`, areas });
const pay = M("m1", "결제", ["api/pay/**"], "codex");
const login = M("m2", "로그인", ["web/login/**"]);
const auth = M("m3", "인증", ["api/**"], "codex");

describe("분배 결과 정리", () => {
  it("없는 이름·빈 몫은 버리고, 이름은 대소문자·공백 무시", () => {
    const r = normalizeAssign({ assign: [{ member: " 결제 ", task: "결제 API" }, { member: "없는에이전트", task: "x" }, { member: "로그인", task: "  " }] }, [pay, login]);
    expect(r.assign).toEqual([{ id: "m1", task: "결제 API", after: [] }]);
    expect(r.warn).toBeNull();
  });
  it("담당 경로가 겹치는 두 에이전트 모두에 몫이 있으면 경고", () => {
    const r = normalizeAssign({ assign: [{ member: "결제", task: "a" }, { member: "인증", task: "b" }] }, [pay, auth]);
    expect(r.warn).toMatch(/결제/);
    expect(r.warn).toMatch(/인증/);
  });
  it("확장자 규칙(**/*.svelte 같은 것)만 겹치는 건 경고하지 않는다", () => {
    const a = M("a", "A", ["web/a/**", "**/*.svelte"]), b = M("b", "B", ["web/b/**", "**/*.svelte"]);
    expect(normalizeAssign({ assign: [{ member: "A", task: "x" }, { member: "B", task: "y" }] }, [a, b]).warn).toBeNull();
  });
  it("이상한 입력이면 빈 결과", () => {
    expect(normalizeAssign(null, [pay]).assign).toEqual([]);
    expect(normalizeAssign({ assign: "x" }, [pay]).assign).toEqual([]);
  });
});

describe("분배 실패 시 모두에게", () => {
  it("null·빈 결과면 모든 에이전트에 원래 지시", () => {
    expect(assignOrAll(null, [pay, login], "지시")).toEqual([{ id: "m1", task: "지시", after: [] }, { id: "m2", task: "지시", after: [] }]);
    expect(assignOrAll({ assign: [] }, [pay, login], "지시")).toHaveLength(2);
    expect(assignOrAll({ assign: [{ id: "m2", task: "로그인만", after: [] }] }, [pay, login], "지시")).toEqual([{ id: "m2", task: "로그인만", after: [] }]);
  });
});

describe("분배 프롬프트", () => {
  it("에이전트마다 이름·맡을 일·경로와 겹치는 경로 주의", () => {
    const p = distributePrompt("회원 기능 만들어", [pay, login]);
    expect(p).toMatch(/결제/);
    expect(p).toMatch(/web\/login\/\*\*/);
    expect(p).toMatch(/로그인 담당/);
    expect(p).toMatch(/같은 파일/);
  });
});

describe("목적 제안 정리", () => {
  it("최대 8명, cli·모델 보정, 이름 중복 피하기, 경로는 문자열만, 추가 에이전트는 lean", () => {
    const raw = { agents: Array.from({ length: 9 }, (_, i) => ({ name: i === 0 ? "결제" : `에이전트${i}`, cli: i === 1 ? "gemini" : "codex", model: i === 2 ? "gpt-6-luna" : "gpt-99", purpose: "p", areas: ["src/x/**", 3] })) };
    const d = normalizeProposal(raw, [pay]);
    expect(d).toHaveLength(8);
    expect(d[0].name).toBe("결제2");
    expect(d[1].cli).toBe("claude");
    expect(d[2].model).toBe("gpt-6-luna");
    expect(d[3].model).toBe("auto");
    expect(d[0].areas).toEqual(["src/x/**"]);
    expect(d.every((x) => x.lean === true)).toBe(true);
  });
  it("이름이 비면 버린다, 이상한 입력이면 빈 목록", () => {
    expect(normalizeProposal({ agents: [{ name: " ", cli: "claude" }] }, [])).toEqual([]);
    expect(normalizeProposal("x", [])).toEqual([]);
  });
  it("제안 프롬프트에 목적·폴더·기존 에이전트", () => {
    const p = proposePrompt("결제 빨리", ["web", "api/pay"], [pay]);
    expect(p).toMatch(/결제 빨리/);
    expect(p).toMatch(/api\/pay/);
    expect(p).toMatch(/8/);
  });
});

import { distributeSchema } from "./distribute";
describe("분배 스키마", () => {
  it("에이전트 이름만 고를 수 있게(엉뚱한 이름을 지어내지 않도록)", () => {
    const sc = distributeSchema([pay, login]) as any;
    expect(sc.properties.assign.items.properties.member.enum).toEqual(["결제", "로그인"]);
  });
});

describe("목적대로 바로 시작: 에이전트별 첫 작업", () => {
  it("제안에 task가 있으면 정리해 담고, 없으면 빈 문자열", () => {
    const d = normalizeProposal({ agents: [
      { name: "결제", cli: "codex", purpose: "결제 API", areas: ["api/**"], task: "  api/pay에 결제 생성 엔드포인트를 만들고 테스트를 추가하라.  " },
      { name: "화면", cli: "claude", purpose: "결제 화면", areas: ["web/**"] },
    ] }, []);
    expect(d.map((x) => x.task)).toEqual(["api/pay에 결제 생성 엔드포인트를 만들고 테스트를 추가하라.", ""]);
  });
  it("첫 작업을 쓰라고 할 때만 프롬프트에 task 안내", () => {
    expect(proposePrompt("결제", [], [], true)).toMatch(/task:/);
    expect(proposePrompt("결제", [], [])).not.toMatch(/task:/);
  });
});

import { stagesOf } from "./distribute";
describe("분배: 순서와 대역 금지", () => {
  const qa = M("m3", "QA", ["tests/**"]);
  it("after(먼저 끝나야 할 에이전트)를 id로 — 없는 이름·자기 자신·몫 없는 에이전트는 뺀다", () => {
    const r = normalizeAssign({ assign: [
      { member: "결제", task: "API", after: [] },
      { member: "QA", task: "API 테스트", after: ["결제", "QA", "없는이름", "로그인"] },
    ] }, [pay, login, qa]);
    expect(r.assign).toEqual([{ id: "m1", task: "API", after: [] }, { id: "m3", task: "API 테스트", after: ["m1"] }]);
  });
  it("단계: 앞 에이전트가 끝난 뒤에 시작, 서로 기다리면(순환) 마지막 단계에 한꺼번에", () => {
    expect(stagesOf([{ id: "a", after: [] }, { id: "b", after: ["a"] }, { id: "c", after: [] }, { id: "d", after: ["b"] }])).toEqual([["a", "c"], ["b"], ["d"]]);
    expect(stagesOf([{ id: "a", after: ["b"] }, { id: "b", after: ["a"] }, { id: "c", after: [] }])).toEqual([["c"], ["a", "b"]]);
    expect(stagesOf([{ id: "a" }, { id: "b" }])).toEqual([["a", "b"]]);
  });
  it("프롬프트: 결과물마다 한 에이전트, 다른 에이전트 결과물의 대역 금지, 앞뒤가 있으면 after, 실제 폴더 경로만", () => {
    const p = distributePrompt("실행 파일 만들어", [pay, login], ["src", "src/api", "tests"]);
    expect(p).toMatch(/src\/api/);
    expect(p).toMatch(/after/);
    expect(p).toMatch(/대역|가짜/);
    expect(p).toMatch(/한 에이전트/);
    const sc = distributeSchema([pay, login]) as any;
    expect(sc.properties.assign.items.properties.after.items.enum).toEqual(["결제", "로그인"]);
  });
});

describe("목적 제안: 모델·생각 깊이·쓸 AI", () => {
  it("이름 앞 @는 떼고, 생각 깊이는 그 CLI에 있는 값만, 쓸 AI를 정하면 그 CLI로 맞춘다", () => {
    const raw = { agents: [
      { name: "@테스트", cli: "codex", model: "gpt-6-astra", effort: "high", purpose: "QA", areas: [] },
      { name: "화면", cli: "claude", model: "opus", effort: "xhigh", purpose: "UI", areas: [] },
      { name: "로직", cli: "codex", model: "gpt-6-luna", effort: "xhigh", purpose: "로직", areas: [] },
    ] };
    const d = normalizeProposal(raw, []);
    expect(d.map((x) => x.name)).toEqual(["테스트", "화면", "로직"]);
    expect(d.map((x) => x.effort)).toEqual(["high", "xhigh", undefined]);
    const only = normalizeProposal(raw, [], "claude");
    expect(only.every((x) => x.cli === "claude")).toBe(true);
    expect(only[0].model).toBe("auto"); // codex 모델은 claude에 없으니 자동
    expect(only[1].model).toBe("opus");
  });
  it("프롬프트: 모델·생각 깊이를 일의 난이도로 고르라고, 쓸 AI를 정하면 그것만", () => {
    const p = proposePrompt("결제", [], []);
    expect(p).toMatch(/effort/);
    expect(p).not.toMatch(/모르면 auto/);
    expect(p).not.toMatch(/@이름으로 부를/);
    expect(proposePrompt("결제", [], [], false, "codex")).toMatch(/codex만/);
  });
});

describe("분배: 지시 범위 지키기", () => {
  it("지시가 요구한 일만 — 다음 단계를 미리 맡기지 말고, '만·까지만·하지 마'면 그 밖의 몫은 아무에게도", () => {
    const p = distributePrompt("기획서까지만 작성해", [pay, login]);
    expect(p).toMatch(/다음 단계/);
    expect(p).toMatch(/범위/);
    expect(p).toMatch(/아무에게도/);
  });
});
