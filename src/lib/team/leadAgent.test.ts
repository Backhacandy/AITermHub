// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { parseLeadReply, needsConfirm, planGate, leadMember, migrateTeam, leadPrompt, addLeadNote, planActions, resolveAssign, type LeadReply } from "./leadAgent";
import { isWorker, type Member } from "./team";

const W = (id: string, name: string, extra: Partial<Member> = {}): Member => ({ id, name, cli: "claude", model: "sonnet", purpose: `${name} 일`, areas: [`${name}/**`], ...extra });

describe("팀장 답 읽기", () => {
  it("블록을 읽고 나머지는 사용자에게 할 말", () => {
    const r = parseLeadReply('목적: 제출용 완성\n기획부터 할게요.\n```aith-lead\n{"purpose":"제출용 완성","scope":"기획까지","wait":false,"actions":[{"type":"assign","to":"기획","task":"GDD 작성"}]}\n```');
    expect(r.say).toBe("목적: 제출용 완성\n기획부터 할게요.");
    expect(r.actions).toEqual([{ type: "assign", to: "기획", task: "GDD 작성" }]);
    expect(r.scope).toBe("기획까지");
  });

  it("블록이 없거나 깨지면 말만, 행동 없음", () => {
    expect(parseLeadReply("그냥 답")).toEqual({ say: "그냥 답", wait: false, actions: [] });
    expect(parseLeadReply("답\n```aith-lead\n{깨짐\n```").actions).toEqual([]);
    expect(parseLeadReply('```aith-lead\n{"actions":[{"type":"rm","to":"x"},{"type":"assign","to":"","task":"t"}]}\n```').actions).toEqual([]);
  });

  it("새로 만들기·역할 바꾸기·큰 요청이면 확인부터", () => {
    const assign = { type: "assign" as const, to: "UI", task: "t" };
    expect(needsConfirm({ say: "", wait: false, actions: [assign] })).toBe(false);
    expect(needsConfirm({ say: "", wait: true, actions: [assign] })).toBe(true);
    expect(needsConfirm({ say: "", wait: false, actions: [{ type: "role", name: "UI", purpose: "효과음도" }] })).toBe(true);
    expect(needsConfirm({ say: "", wait: false, actions: [{ type: "create", name: "QA", cli: "claude", model: "sonnet", purpose: "테스트", areas: [] }] })).toBe(true);
  });

  it("기획 관문", () => {
    expect(planGate("기획서부터 짜고 UI까지", false)).toBe(true);
    expect(planGate("기획서부터 짜고 UI까지", true)).toBe(false);
    expect(planGate("버튼 색 바꿔", false)).toBe(false);
  });
});

describe("옛 팀 옮기기", () => {
  it("대화·역할 그대로, 브리핑만 빠지고 팀장이 맨 앞, 두 번 해도 하나", () => {
    const old = [W("m1", "기획", { resume: "s1" }), W("m2", "UI", { resume: "s2", model: "opus" }), W("m3", "브리핑", { brief: true, resume: "s3" })];
    const a = migrateTeam(old);
    expect(a.changed).toBe(true);
    expect(a.members.map((m) => m.name)).toEqual(["팀장", "기획", "UI"]);
    expect(a.members[0]).toMatchObject({ id: "lead", lead: true, cli: "claude", model: "opus" });
    expect(a.members[1]).toBe(old[0]);
    expect(a.members[2]).toBe(old[1]);
    expect(migrateTeam(a.members)).toEqual({ members: a.members, changed: false });
  });

  it("팀장은 일을 나눠 받는 에이전트가 아니다", () => {
    expect(isWorker({ lead: true })).toBe(false);
    expect(isWorker({})).toBe(true);
    expect(leadMember([W("lead", "팀장")]).name).toBe("팀장2");
  });
});

describe("팀장 프롬프트", () => {
  it("처음엔 규칙과 팀, 결과 차례엔 결과", () => {
    const ms = migrateTeam([W("m1", "UI")]).members;
    const p = leadPrompt({ turn: { kind: "user", text: "기획만 해줘" }, members: ms, status: { m1: "쉬는 중" }, notes: ["기획과 UI를 한 사람에게 맡기지 않는다"], full: true, cap: 8 });
    expect(p).toContain("aith-lead");
    expect(p).toContain("코드");
    expect(p).toContain("UI");
    expect(p).toContain("쉬는 중");
    expect(p).toContain("기획과 UI를 한 사람에게 맡기지 않는다");
    expect(p).toContain("기획만 해줘");
    const q = leadPrompt({ turn: { kind: "results", text: "기획만 해줘", results: [{ name: "UI", answer: "### 인계\n- Main.unity" }] }, members: ms, status: {}, notes: [], full: false, cap: 8 });
    expect(q).not.toContain(p.slice(0, 40));
    expect(q).toContain("Main.unity");
  });

  it("메모는 겹치지 않게 20개까지", () => {
    let n: string[] = [];
    for (let i = 0; i < 25; i++) n = addLeadNote(n, `메모 ${i}`);
    expect(n.length).toBe(20);
    expect(addLeadNote(["a"], " a ")).toEqual(["a"]);
    expect(addLeadNote(["a"], "  ")).toEqual(["a"]);
  });
});

describe("팀장 행동 적용", () => {
  it("만들기·역할·배치를 이름으로, 상한·없는 이름은 오류로", () => {
    const ms = migrateTeam([W("m1", "기획"), W("m2", "UI")]).members;
    const p = planActions(ms, [
      { type: "create", name: "QA", cli: "claude", model: "sonnet", effort: "high", purpose: "테스트", areas: ["Tests/**"] },
      { type: "create", name: "UI", cli: "codex", model: "없는모델", purpose: "중복 이름", areas: [] },
      { type: "role", name: "UI", purpose: "UI + 효과음 연결" },
      { type: "role", name: "없음", purpose: "x" },
      { type: "assign", to: "@기획", task: "GDD" },
      { type: "assign", to: "QA", task: "흐름 검증", after: ["기획"] },
      { type: "assign", to: "팀장", task: "x" },
    ], 3);
    expect(p.creates.map((c) => c.name)).toEqual(["QA"]);
    expect(p.errors.join("\n")).toMatch(/상한/);
    expect(p.errors.join("\n")).toMatch(/없음/);
    expect(p.errors.join("\n")).toMatch(/팀장/);
    expect(p.roles).toEqual([{ id: "m2", purpose: "UI + 효과음 연결", note: expect.stringContaining("UI") }]);
    expect(p.assign).toEqual([{ name: "기획", task: "GDD", after: [] }, { name: "QA", task: "흐름 검증", after: ["기획"] }]);
  });

  it("만들 에이전트의 모델·생각은 목록에 있는 것만", () => {
    const p = planActions([], [{ type: "create", name: "X", cli: "codex", model: "없는모델", effort: "max", purpose: "p", areas: [] }], 8);
    expect(p.creates[0]).toMatchObject({ name: "X", cli: "codex", model: "auto", lean: true });
    expect(p.creates[0].effort).toBeUndefined();
  });

  it("이름 → id, after로 단계", () => {
    const ms = [...migrateTeam([W("m1", "기획"), W("m2", "UI")]).members, W("m3", "QA")];
    const r = resolveAssign(ms, [{ name: "기획", task: "GDD", after: [] }, { name: "UI", task: "씬", after: [] }, { name: "qa", task: "검증", after: ["기획", "UI"] }, { name: "유령", task: "x", after: [] }]);
    expect(r.ids).toEqual(["m1", "m2", "m3"]);
    expect(r.preset).toEqual({ m1: "GDD", m2: "씬", m3: "검증" });
    expect(r.order).toEqual([["m1", "m2"], ["m3"]]);
    expect(r.errors.join()).toMatch(/유령/);
  });
});

import { leadGate, firstStage } from "./leadAgent";
describe("확인 관문", () => {
  const R = (actions: LeadReply["actions"], extra: Partial<LeadReply> = {}): LeadReply => ({ say: "", wait: false, actions, ...extra });
  const a = { type: "assign" as const, to: "기획", task: "GDD" };
  const b = { type: "assign" as const, to: "UI", task: "구현", after: ["기획"] };
  const base = { instruction: "기획서 짜고 UI까지 만들어", planConfirmed: false, rounds: 0, limit: 3 };
  it("첫 배치: 기획 관문이면 확인 없이 첫 단계만(뒤 단계는 기획 확인 뒤로)", () => {
    expect(leadGate({ ...base, turn: "user", reply: R([a, b]) })).toEqual({ kind: null, firstStageOnly: true });
    expect(leadGate({ ...base, instruction: "버튼 색 바꿔", turn: "user", reply: R([a, b]) })).toEqual({ kind: null, firstStageOnly: false });
  });
  it("결과·직접·고치기 차례: 기획 확인 전이면 배치는 기획 확인부터", () => {
    for (const turn of ["results", "direct", "revise"] as const) expect(leadGate({ ...base, turn, reply: R([b]) }).kind).toBe("plan");
    expect(leadGate({ ...base, planConfirmed: true, turn: "confirmed", reply: R([b]) }).kind).toBe(null);
  });
  it("범위 제한·후속 상한·큰 배치·팀장이 청한 확인", () => {
    expect(leadGate({ ...base, instruction: "분석까지만 해줘", turn: "results", reply: R([a]) }).kind).toBe("allocation");
    expect(leadGate({ ...base, instruction: "고쳐줘", rounds: 3, turn: "results", reply: R([a]) })).toEqual({ kind: "allocation", firstStageOnly: false, limit: true });
    expect(leadGate({ ...base, instruction: "고쳐줘", turn: "user", reply: R([a], { wait: true }) }).kind).toBe("allocation");
    expect(leadGate({ ...base, instruction: "고쳐줘", turn: "results", reply: R([], { confirm: { kind: "other", title: "t", body: "b" } }) }).kind).toBe("other");
    expect(leadGate({ ...base, instruction: "고쳐줘", turn: "results", reply: R([]) }).kind).toBe(null);
  });
  it("첫 단계만: after가 있는 배치는 뒤로", () => {
    const c = { type: "role" as const, name: "UI", purpose: "x" };
    expect(firstStage([a, b, c])).toEqual({ now: [a, c], later: [b] });
  });
});

describe("합치기·원래 폴더 담당", () => {
  it("merge 행동과 create의 home을 읽는다", () => {
    const r = parseLeadReply('끝났어요\n```aith-lead\n{"actions":[{"type":"merge"},{"type":"create","name":"QA","cli":"claude","model":"sonnet","purpose":"플레이 테스트","areas":[],"home":true}]}\n```');
    expect(r.actions[0]).toEqual({ type: "merge" });
    expect(r.actions[1]).toMatchObject({ type: "create", name: "QA", home: true });
    const p = planActions([], r.actions, 8);
    expect(p.merge).toBe(true);
    expect(p.creates[0].home).toBe(true);
    expect(planActions([], [], 8).merge).toBe(false);
  });
  it("합치기만 있는 답은 관문 없이", () => {
    const g = leadGate({ turn: "results", reply: { say: "", wait: false, actions: [{ type: "merge" }] }, instruction: "기획부터", planConfirmed: false, rounds: 9, limit: 3 });
    expect(g.kind).toBe(null);
  });
  it("엔진 프로젝트 안내와 합치기 차례", () => {
    const ms = migrateTeam([W("m1", "UI")]).members;
    const p = leadPrompt({ turn: { kind: "merge", text: "충돌: UI — a.cs" }, members: ms, status: {}, notes: [], full: true, cap: 8, kind: "unity" });
    expect(p).toContain("에디터");
    expect(p).toContain("[합치기 결과]");
    expect(p).toContain("충돌: UI — a.cs");
    expect(p).toContain("merge");
    // 합치기와 맡길 일을 함께 내면 먼저 합친다는 것, 결과가 어디로 오는지를 팀장이 안다(예전엔 말없이 버려져 팀장이 합쳐진 줄 알았다)
    expect(p).toContain("merge와 맡길 일을 한 번에 내면 앱이 먼저 합치고");
    expect(p).toContain("앱(합치기)");
    expect(leadPrompt({ turn: { kind: "user", text: "x" }, members: ms, status: {}, notes: [], full: false, cap: 8, kind: "other" })).not.toContain("에디터");
  });
});

describe("운영 방식 적용", () => {
  it("라이트면 만들 에이전트 모델을 등급 3 이하로, chrome 전달", () => {
    const p = planActions([], [{ type: "create", name: "UI", cli: "claude", model: "opus", purpose: "화면", areas: [], chrome: true }], 4, 3);
    expect(p.creates[0]).toMatchObject({ model: "sonnet", chrome: true });
  });
  it("프롬프트에 운영 방식", () => {
    const p = leadPrompt({ turn: { kind: "user", text: "x" }, members: [], status: {}, notes: [], full: false, cap: 4, mode: "lite" });
    expect(p).toContain("[운영 방식] 라이트");
  });
});

import { mergeTurnText } from "./leadAgent";
describe("합친 뒤 팀장에게", () => {
  const name = (id: string) => ({ m1: "스크립트", m2: "UI" })[id] ?? id;
  it("합쳤으면 알리고 계획한 다음 단계를 이어 가게", () => {
    const t = mergeTurnText({ merged: ["m1"], conflicts: [], failed: [], head: "abc123" }, name);
    expect(t).toContain("스크립트");
    expect(t).toContain("abc123");
    expect(t).toMatch(/다음 단계/);
  });
  it("충돌·실패가 있으면 그 몫과 함께", () => {
    const t = mergeTurnText({ merged: ["m2"], conflicts: [{ member: "m1", files: ["a.cs"] }], failed: [], head: "x" }, name);
    expect(t).toContain("스크립트: a.cs");
    expect(t).toContain("합친 것: UI");
  });
  it("합친 것도 문제도 없으면 알릴 것 없음", () => {
    expect(mergeTurnText({ merged: [], conflicts: [], failed: [], head: "" }, name)).toBeNull();
  });
  // 팀장이 merge를 냈는데 아무것도 안 들어가면 팀장은 알 길이 없었다 — 빠진 까닭을 늘 알린다
  it("일하는 중이라 빠진 에이전트는 끝난 뒤 다시 내라고", () => {
    const t = mergeTurnText({ merged: [], conflicts: [], failed: [], head: "", busy: ["m1"] }, name)!;
    expect(t).toContain("스크립트");
    expect(t).toMatch(/일하는 중/);
    expect(t).toMatch(/합친 것 없음/);
  });
  it("새 커밋이 없어 합칠 게 없던 에이전트도 알린다", () => {
    const t = mergeTurnText({ merged: ["m2"], conflicts: [], failed: [], head: "x", nothing: ["m1"] }, name)!;
    expect(t).toContain("합친 것: UI");
    expect(t).toMatch(/새 커밋이 없.*스크립트/);
  });
  it("합칠 브랜치가 하나도 없으면(모두 일하는 중) 그것도 알린다", () => {
    expect(mergeTurnText({ merged: [], conflicts: [], failed: [], head: "", busy: ["m1", "m2"] }, name)).toMatch(/스크립트, UI/);
  });
});

describe("합치기 제목·설명", () => {
  it("팀장이 낸 title·body를 읽어 합치기 계획에 싣는다", () => {
    const r = parseLeadReply('끝났어요\n```aith-lead\n{"actions":[{"type":"merge","title":"feat(frontend): 로그인 화면","body":"로그인 화면 추가. 앱 실행 후 확인"}]}\n```');
    expect(r.actions).toEqual([{ type: "merge", title: "feat(frontend): 로그인 화면", body: "로그인 화면 추가. 앱 실행 후 확인" }]);
    const p = planActions([], r.actions, 8);
    expect(p).toMatchObject({ merge: true, mergeTitle: "feat(frontend): 로그인 화면", mergeBody: "로그인 화면 추가. 앱 실행 후 확인" });
  });
  it("없으면 그냥 합치기", () => {
    const r = parseLeadReply('```aith-lead\n{"actions":[{"type":"merge"}]}\n```');
    expect(r.actions).toEqual([{ type: "merge" }]);
    expect(planActions([], r.actions, 8).mergeTitle).toBeUndefined();
  });
});

describe("라이트에서 만든 에이전트", () => {
  it("등급 때문에 낮춘 모델은 원래 모델을 기억한다(맥스로 바꾸면 되돌린다)", () => {
    const p = planActions([], [{ type: "create", name: "설계", cli: "claude", model: "opus", purpose: "설계", areas: [] }], 4, 3);
    expect(p.creates[0]).toMatchObject({ model: "sonnet", maxModel: "opus" });
    const q = planActions([], [{ type: "create", name: "QA", cli: "claude", model: "haiku", purpose: "검사", areas: [] }], 4, 3);
    expect(q.creates[0].maxModel).toBeUndefined();
  });
});

describe("합치기 확인을 끈 팀", () => {
  it("팀장에게 합칠지 묻지 말라고 알린다(켜 둔 팀은 그대로)", () => {
    const base = { turn: { kind: "user" as const, text: "x" }, members: [], status: {}, notes: [], full: false, cap: 8 };
    expect(leadPrompt({ ...base, mergeAsk: false })).toMatch(/합칠지 사용자에게 묻지 말고/);
    expect(leadPrompt(base)).not.toMatch(/합치기 확인을 껐다/);
  });
});

describe("인원 상한", () => {
  it("맥스는 인원 제한이 없다 — 9번째도 만들고, 팀장에게 상한 대신 '필요할 때만'을 알린다", () => {
    const ms = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: `A${i}`, cli: "claude" as const, model: "sonnet", purpose: "", areas: [] }));
    const plan = planActions(ms as never, [{ type: "create", name: "새사람", cli: "claude", model: "sonnet", purpose: "p" } as never], Infinity);
    expect(plan.creates).toHaveLength(1);
    expect(plan.errors).toEqual([]);
    const full = leadPrompt({ turn: { kind: "user", text: "x" }, members: [], status: {}, notes: [], full: true, cap: Infinity, mode: "max" });
    expect(full).toContain("인원 상한은 없다");
    expect(full).not.toContain("Infinity");
    expect(leadPrompt({ turn: { kind: "user", text: "x" }, members: [], status: {}, notes: [], full: true, cap: 4, mode: "lite" })).toContain("최대 4명");
    expect(planActions(ms.slice(0, 4) as never, [{ type: "create", name: "새사람", cli: "claude", model: "sonnet", purpose: "p" } as never], 4).creates).toHaveLength(0);
  });
});

describe("팀장이 일마다 모델 고르기", () => {
  const ws = migrateTeam([{ id: "m1", name: "백엔드", cli: "codex", model: "gpt-6-astra", purpose: "API", areas: [] }]).members;
  it("role로 모델·생각만 바꾸면 확인 없이 바로, 목록에 없는 모델은 그대로", () => {
    const r = parseLeadReply('```aith-lead\n{"actions":[{"type":"role","name":"백엔드","model":"gpt-6.2-sol","effort":"high"},{"type":"assign","to":"백엔드","task":"x"}]}\n```');
    expect(needsConfirm(r)).toBe(false);
    const p = planActions(ws, r.actions, 8);
    expect(p.roles[0]).toMatchObject({ model: "gpt-6.2-sol", effort: "high" });
    const bad = planActions(ws, parseLeadReply('```aith-lead\n{"actions":[{"type":"role","name":"백엔드","model":"opus"}]}\n```').actions, 8);
    expect(bad.roles).toEqual([]);
    expect(bad.errors[0]).toContain("모델 목록에 없어");
  });
  it("라이트(등급 3까지)면 낮추고 원래 모델을 기억", () => {
    const p = planActions(ws, parseLeadReply('```aith-lead\n{"actions":[{"type":"role","name":"백엔드","model":"gpt-6.2-astra"}]}\n```').actions, 8, 3);
    expect(p.roles[0]).toMatchObject({ model: "gpt-6.2-sol", maxModel: "gpt-6.2-astra" });
  });
  it("맡을 일을 바꾸는 role은 여전히 확인받는다", () => {
    expect(needsConfirm(parseLeadReply('```aith-lead\n{"actions":[{"type":"role","name":"백엔드","purpose":"새 일"}]}\n```'))).toBe(true);
  });
});
