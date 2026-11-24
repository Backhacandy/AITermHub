// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { fromPair, routeTeam, teamPrompt, teamIntro, memosFrom, trespassTeam, splitByCap, uniqueName, teamKey, briefMember, briefPrompt, isWorker, type Member } from "./team";
import { DEFAULT_ROLES } from "$lib/pair/route";

const M = (id: string, name: string, cli: "claude" | "codex", areas: string[], purpose = ""): Member => ({ id, name, cli, model: "auto", purpose, areas });
const pay = M("m1", "결제", "codex", ["api/**"], "결제 API");
const login = M("m2", "로그인", "claude", ["web/login/**"], "로그인 화면");
const my = M("m3", "마이", "claude", ["web/my/**"], "마이페이지");

describe("기존 협업 탭 → 두 에이전트", () => {
  it("대화 id·모델·영역을 그대로, 백엔드 에이전트 먼저", () => {
    const ms = fromPair({ resume: "S", resume2: "T", models: { claude: "opus", codex: "auto" } }, DEFAULT_ROLES, { front: ["web/**"], back: ["api/**"] });
    expect(ms).toEqual([
      { id: "codex", name: "Codex", cli: "codex", model: "auto", purpose: "백엔드", areas: ["api/**"], resume: "T" },
      { id: "claude", name: "Claude", cli: "claude", model: "opus", purpose: "프론트", areas: ["web/**"], resume: "S" },
    ]);
  });
  it("역할을 바꿨으면 Claude가 백엔드 에이전트", () => {
    const ms = fromPair({}, { back: "claude", front: "codex" }, { front: ["web/**"], back: ["api/**"] });
    expect(ms.map((m) => [m.id, m.purpose])).toEqual([["claude", "백엔드"], ["codex", "프론트"]]);
    expect(ms[1].model).toBe("auto");
  });
});

describe("@이름으로 에이전트 고르기", () => {
  it("에이전트 이름(두 글자 이상 앞부분), 여러 개", () => {
    expect(routeTeam("@결제 버튼 고쳐", [pay, login])).toEqual({ ids: ["m1"], text: "버튼 고쳐" });
    expect(routeTeam("@로그 @결제 같이", [pay, login]).ids).toEqual(["m2", "m1"]);
    expect(routeTeam("@결 x", [pay, login])).toEqual({ ids: [], text: "@결 x" });
  });
  it("옛 호출어 @cl/@co는 그 CLI의 첫 에이전트, 에이전트 이름이 먼저", () => {
    const c1 = M("a", "Codex", "codex", []), c2 = M("b", "백엔드2", "codex", []);
    expect(routeTeam("@co API", [c1, c2]).ids).toEqual(["a"]);
    const named = M("x", "Codex작업", "claude", []);
    expect(routeTeam("@codex작업 x", [c1, named]).ids).toEqual(["x"]);
  });
  it("지정 없으면 빈 목록", () => {
    expect(routeTeam("화면 고쳐", [pay, login])).toEqual({ ids: [], text: "화면 고쳐" });
  });
});

describe("에이전트 프롬프트", () => {
  it("짧은 형식: 내 이름·몫·다른 에이전트 수정 금지·내 몫 없음·인계, 전체의 절반 미만", () => {
    const o = { me: login, members: [pay, login, my], instruction: "회원 기능 만들어", task: "로그인 화면만", together: true };
    const full = teamPrompt({ ...o, full: true });
    const short = teamPrompt({ ...o, full: false });
    expect(short).toMatch(/로그인/);
    expect(short).toMatch(/로그인 화면만/);
    expect(short).toMatch(/web\/my\/\*\*/);
    expect(short).toMatch(/수정 금지/);
    expect(short).toMatch(/내 몫 없음/);
    expect(short).toMatch(/### 인계/);
    expect(short.length).toBeLessThan(full.length / 2);
    expect(full.startsWith(teamIntro(login, [pay, login, my]))).toBe(true);
  });
  it("Codex 에이전트에만 패치 규칙", () => {
    expect(teamIntro(pay, [pay, login])).toMatch(/apply_patch/);
    expect(teamIntro(login, [pay, login])).not.toMatch(/apply_patch/);
  });
  it("이름·영역이 바뀌면 키가 바뀐다", () => {
    expect(teamKey([pay, login])).toBe(teamKey([{ ...pay }, { ...login }]));
    expect(teamKey([pay, login])).not.toBe(teamKey([pay, { ...login, areas: ["x/**"] }]));
  });
});

describe("인계 메모 나누기", () => {
  it("@이름 요청은 그 에이전트에, 이름 없는 요청과 정보는 다른 모든 에이전트에", () => {
    const ans = "작업했어요\n### 인계\n- API: /pay\n- 요청: @로그인 버튼 연결\n- 요청: 응답 형식 맞춰줘";
    const m = memosFrom(ans, pay, [pay, login, my]);
    expect(Object.keys(m).sort()).toEqual(["m2", "m3"]);
    expect(m.m2).toMatch(/API/);
    expect(m.m2).toMatch(/버튼 연결/);
    expect(m.m3).toMatch(/API/);
    expect(m.m3).toMatch(/응답 형식/);
    expect(m.m3).not.toMatch(/버튼 연결/);
  });
  it("인계가 없음이면 아무에게도", () => {
    expect(memosFrom("끝\n### 인계\n없음", pay, [pay, login])).toEqual({});
  });
});

describe("침범·상한·이름", () => {
  it("내가 고친 파일 중 다른 에이전트 영역이고 내 영역은 아닌 것", () => {
    const ui = M("u", "화면", "claude", ["web/**"]);
    expect(trespassTeam(["web/a.svelte", "api/b.rs", "README.md"], pay, [pay, ui])).toEqual(["web/a.svelte"]);
  });
  it("동시 실행 상한", () => {
    expect(splitByCap(["a", "b", "c", "d"], 1, 3)).toEqual({ now: ["a", "b"], later: ["c", "d"] });
    expect(splitByCap(["a"], 5, 3)).toEqual({ now: [], later: ["a"] });
  });
  it("이름 중복이면 숫자 붙이기", () => {
    expect(uniqueName("결제", [pay])).toBe("결제2");
    expect(uniqueName("결제", [pay, M("z", "결제2", "claude", [])])).toBe("결제3");
    expect(uniqueName("새", [pay])).toBe("새");
  });
});

import { userText } from "$lib/work/userText";
describe("지난 대화 표시", () => {
  it("팀 탭 안내·내 몫은 빼고 지시만", () => {
    for (const full of [true, false]) {
      expect(userText(teamPrompt({ me: login, members: [pay, login], instruction: "회원 기능", task: "로그인만", together: true, full }))).toBe("회원 기능");
    }
  });
});

import { hqMax } from "./team";
describe("동시 실행 상한 값", () => {
  const store = (v: string | null) => ({ getItem: () => v }) as unknown as Storage;
  it("AI 회사 동시 근무 인원(aith.hq의 max), 없거나 깨졌으면 4", () => {
    expect(hqMax(store(null))).toBe(4);
    expect(hqMax(store('{"max":6}'))).toBe(6);
    expect(hqMax(store("{깨짐"))).toBe(4);
    expect(hqMax(store('{"max":0}'))).toBe(4);
  });
});

import { applyRoleEdits } from "./team";
describe("역할 바꾸기", () => {
  it("이름·맡을 일·경로를 바꾸고 바뀐 에이전트만 알린다", () => {
    const ms = [M("a", "결제", "codex", ["api/**"], "결제 API"), M("b", "화면", "claude", ["web/**"], "화면")];
    const notes = applyRoleEdits(ms, {
      a: { name: "로그인", purpose: "로그인 API", areas: "api/auth/**\n\n api/user/** " },
      b: { name: "화면", purpose: "화면", areas: "web/**" },
    });
    expect(ms[0]).toMatchObject({ name: "로그인", purpose: "로그인 API", areas: ["api/auth/**", "api/user/**"] });
    expect(notes).toEqual(["결제 → 로그인 · 로그인 API"]);
  });
  it("빈 이름은 그대로, 겹치는 이름은 숫자를 붙인다", () => {
    const ms = [M("a", "결제", "codex", []), M("b", "화면", "claude", [])];
    applyRoleEdits(ms, { a: { name: "  ", purpose: "", areas: "" }, b: { name: "결제", purpose: "", areas: "" } });
    expect(ms.map((m) => m.name)).toEqual(["결제", "결제2"]);
  });
});

import { teamRoleSwitch } from "./team";
describe("두 에이전트 역할 바꾸기 지시", () => {
  const pair = () => [M("codex", "Codex", "codex", ["api/**"], "백엔드"), M("claude", "Claude", "claude", ["web/**"], "프론트")];
  it("역할 바꿔 → 맡을 일·경로를 맞바꾼다", () => {
    const ms = pair();
    expect(teamRoleSwitch("역할 바꿔", ms)).toEqual({ changed: true, note: "Codex 프론트 · Claude 백엔드" });
    expect(ms[0]).toMatchObject({ purpose: "프론트", areas: ["web/**"] });
    expect(ms[1]).toMatchObject({ purpose: "백엔드", areas: ["api/**"] });
  });
  it("지금 역할 기준으로 판단(한 번 바꾼 뒤에도)", () => {
    const ms = pair();
    teamRoleSwitch("역할 바꿔", ms);
    expect(teamRoleSwitch("codex가 프론트", ms)).toEqual({ changed: false, note: "Codex 프론트 · Claude 백엔드" });
    expect(teamRoleSwitch("클로드가 프론트", ms)?.changed).toBe(true);
    expect(ms[1].purpose).toBe("프론트");
  });
  it("역할 지시가 아니거나 같은 CLI 두 에이전트·세 에이전트면 null", () => {
    expect(teamRoleSwitch("로그인 화면 만들어", pair())).toBeNull();
    expect(teamRoleSwitch("역할 바꿔", [M("a", "A", "claude", []), M("b", "B", "claude", [])])).toBeNull();
    expect(teamRoleSwitch("역할 바꿔", [...pair(), M("c", "C", "claude", [])])).toBeNull();
  });
});

describe("역할이 바뀐 뒤 안내", () => {
  it("changed면 앞선 안내 대신 따르라는 줄, 사용자 글 표시는 그대로", () => {
    const ui = M("u", "화면", "claude", ["web/**"], "화면");
    const p = teamPrompt({ me: pay, members: [pay, ui], instruction: "고쳐", together: false, full: true, changed: true });
    expect(p).toContain("앞서 받은 팀 안내 대신");
    expect(teamPrompt({ me: pay, members: [pay, ui], instruction: "고쳐", together: false, full: true })).not.toContain("앞서 받은");
    expect(userText(p)).toBe("고쳐");
  });
});

import { rowsFor, buildTeam, type Row } from "./team";
describe("새 세션 창: 에이전트 수 → 에이전트", () => {
  const one: Row[] = [{ name: "", cli: "claude", model: "opus", purpose: "", areas: [] }];
  it("1 → 2는 지금 협업처럼 프론트·백엔드, 그 뒤는 빈 Claude, 줄이면 앞에서부터 남긴다", () => {
    const two = rowsFor(2, one);
    expect(two.map((r) => [r.cli, r.purpose, r.model])).toEqual([["claude", "프론트", "opus"], ["codex", "백엔드", "auto"]]);
    expect(rowsFor(2, [{ ...one[0], cli: "codex" }]).map((r) => [r.cli, r.purpose])).toEqual([["codex", "백엔드"], ["claude", "프론트"]]);
    const four = rowsFor(4, two);
    expect(four.slice(2).map((r) => [r.cli, r.purpose])).toEqual([["claude", ""], ["claude", ""]]);
    expect(rowsFor(1, four)).toEqual([two[0]]);
    expect(one[0].purpose).toBe("");
  });
  it("에이전트: 이름 채우기·겹치면 숫자, 프론트·백엔드는 감지 영역, 첫 에이전트 말고는 lean", () => {
    const rows: Row[] = [
      { name: "", cli: "codex", model: "auto", purpose: "백엔드", areas: [] },
      { name: "", cli: "claude", model: "opus", effort: "max", purpose: "프론트", areas: [] },
      { name: "", cli: "claude", model: "auto", purpose: "", areas: ["docs/**"] },
    ];
    const t = buildTeam(rows, { front: ["web/**"], back: ["api/**"] });
    expect(t.map((m) => [m.id, m.name, m.areas, !!m.lean])).toEqual([
      ["m1", "Codex", ["api/**"], false],
      ["m2", "Claude", ["web/**"], true],
      ["m3", "Claude2", ["docs/**"], true],
    ]);
    expect(t[1].effort).toBe("max");
    expect(t[0].effort).toBeUndefined();
  });
});

import { kickoffFrom } from "./team";
describe("목적대로 바로 시작", () => {
  it("첫 작업이 있는 줄만 에이전트 id에 붙인다", () => {
    const team = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
    expect(kickoffFrom(" 결제 빨리 ", [{ task: "API 만들기" }, { task: "  " }, { task: "화면" }], team))
      .toEqual({ goal: "결제 빨리", tasks: { m1: "API 만들기", m3: "화면" } });
  });
  it("목적이나 첫 작업이 없으면 null", () => {
    expect(kickoffFrom("", [{ task: "x" }], [{ id: "m1" }])).toBeNull();
    expect(kickoffFrom("목적", [{}], [{ id: "m1" }])).toBeNull();
  });
});

import { requestedIds } from "./team";
describe("다른 에이전트 깨우기: 콕 집은 요청", () => {
  it("'요청: @이름'으로 집힌 에이전트만, 이름 없는 요청·정보 줄은 아님", () => {
    const api = M("a", "API", "codex", ["api/**"]), ui = M("u", "화면", "claude", ["web/**"]), doc = M("d", "문서", "claude", []);
    const answer = "다 했어요\n### 인계\n- 바뀐 파일: api/pay.rs\n- 요청: @화면 결제 버튼에서 /pay 호출해 줘\n- 요청: 테스트 돌려 줘\n- 요청: @화면 로딩 표시도";
    expect(requestedIds(answer, api, [api, ui, doc])).toEqual(["u"]);
    expect(requestedIds("인계 없음", api, [api, ui])).toEqual([]);
    expect(requestedIds("### 인계\n요청: @API 자기 자신", api, [api, ui])).toEqual([]);
  });
});

describe("브리핑 담당", () => {
  const brief = { ...M("m9", "브리핑", "claude", []), ...briefMember([pay, login]), id: "m9" } as Member;
  const all = [pay, login, brief];
  it("일하는 에이전트가 아니다: 다른 에이전트 안내·요청·인계에서 빠진다", () => {
    expect(isWorker(brief)).toBe(false);
    expect(teamIntro(pay, all)).not.toMatch(/브리핑/);
    expect(requestedIds("### 인계\n- 요청: @브리핑 정리해 줘", pay, all)).toEqual([]);
    expect(Object.keys(memosFrom("### 인계\n- API 형식 바뀜", pay, all))).toEqual(["m2"]);
  });
  it("결과를 받아 완성·단계·테스트 가능 여부로 정리하라고, 파일은 고치지 말라고", () => {
    const p = briefPrompt({ instruction: "결제 붙여 줘", results: [{ name: "결제", answer: "charge 구현\n### 인계\n- 요청: @로그인 버튼" }], files: "src/a.ts" });
    expect(p).toMatch(/결제 붙여 줘/);
    expect(p).toMatch(/charge 구현/);
    expect(p).toMatch(/src\/a\.ts/);
    for (const h of ["완성된 것", "지금 단계", "테스트", "결정"]) expect(p).toMatch(new RegExp(h));
    expect(p).toMatch(/고치지/);
  });
  it("이름은 겹치지 않게, 가벼운 모델로", () => {
    const b = briefMember([{ ...pay, name: "브리핑" }]);
    expect(b.name).toBe("브리핑2");
    expect(b.brief).toBe(true);
    expect(b.model).toBe("haiku");
  });
});

describe("이름이 @로 시작하는 에이전트", () => {
  it("'@테스트'라는 이름도 @테스트로 부를 수 있다", () => {
    const t = M("m4", "@테스트", "claude", []);
    const g = M("m3", "@게임", "claude", []);
    expect(routeTeam("@테스트 @게임 이어서 해 줘", [g, t])).toEqual({ ids: ["m4", "m3"], text: "이어서 해 줘" });
    expect(requestedIds("### 인계\n- 요청: @테스트 다시 돌려 줘", g, [g, t])).toEqual(["m4"]);
  });
});

describe("브리핑 글 길이", () => {
  it("에이전트 결과가 아무리 길어도 앞부분과 끝(인계)만 담아 한 번에 몇 천 자로", () => {
    const long = "가".repeat(50_000) + "\n### 인계\n- 요청: @화면 버튼";
    const p = briefPrompt({ instruction: "x", results: [{ name: "A", answer: long }, { name: "B", answer: long }], files: "f\n".repeat(5000) });
    expect(p.length).toBeLessThan(12_000);
    expect(p).toMatch(/요청: @화면 버튼/);
    expect(p).toMatch(/…\(줄임\)…/);
  });
});

describe("동시 작업 규칙: 대역 금지", () => {
  it("다른 에이전트 결과물은 만들지 말고(가짜·대역 포함) 인계로 요청 — '가정하고 진행'은 없다", () => {
    const o = { me: login, members: [pay, login, my], instruction: "회원 기능", together: true };
    for (const full of [true, false]) {
      const p = teamPrompt({ ...o, full });
      expect(p).toMatch(/대역/);
      expect(p).toMatch(/요청: @이름/);
      expect(p).not.toMatch(/가정하/);
      expect(p.includes("칸")).toBe(false); // 예전 이름(칸)이 남지 않게
    }
  });
});

import { overlapsFrom } from "./team";
describe("겹친 일 찾기", () => {
  it("같은 파일을 여럿이, 같은 역할 파일(진입점·프로젝트 파일)을 여러 곳에, 대역으로 보이는 파일", () => {
    const o = overlapsFrom([
      { name: "로직", files: ["GameLogicConsole/Src/Program.cs", "GameLogicConsole/ConsoleApp.csproj", "Assets/a.cs"] },
      { name: "QA", files: ["Assets/00_QA/ConsoleAppTests/src/Program.cs", "qa_tmp/MockGameLogic/Mock.cs", "Assets/a.cs"] },
      { name: "데이터", files: ["Assets/Resources/x.csv"] },
    ]);
    expect(o.some((x) => /같은 파일/.test(x) && /Assets\/a\.cs/.test(x) && /로직·QA/.test(x))).toBe(true);
    expect(o.some((x) => /Program\.cs/.test(x) && /로직/.test(x) && /QA/.test(x))).toBe(true);
    expect(o.some((x) => /대역/.test(x) && /Mock\.cs/.test(x) && /QA/.test(x))).toBe(true);
    expect(o.some((x) => /데이터/.test(x))).toBe(false);
  });
  it("겹친 게 없으면 빈 목록", () => {
    expect(overlapsFrom([{ name: "A", files: ["a/x.ts"] }, { name: "B", files: ["b/y.ts"] }])).toEqual([]);
  });
});

describe("브리핑에 겹친 일", () => {
  it("겹침 의심 줄을 넘기고 '겹친 일' 에이전트를 쓰게 한다", () => {
    const p = briefPrompt({ instruction: "x", results: [{ name: "A", answer: "a" }], overlaps: ["같은 파일을 여럿이 고침: a.cs — A·B"] });
    expect(p).toMatch(/\[겹침 의심[^\]]*\][\s\S]*a\.cs/);
    expect(p).toMatch(/### 겹친 일/);
    expect(briefPrompt({ instruction: "x", results: [{ name: "A", answer: "a" }] })).toMatch(/### 겹친 일/);
  });
});

import { routeExtra, extraText } from "./team";
describe("작업 중에 보낸 전체 지시", () => {
  it("받을 에이전트 중 일하는 쪽은 끼워 넣고, 쉬는 쪽은 시작한다", () => {
    const r = routeExtra([{ id: "a", task: "A 몫" }, { id: "b", task: "B 몫" }, { id: "c", task: "C 몫" }], (id) => id !== "b");
    expect(r.interject.map((x) => x.id)).toEqual(["a", "c"]);
    expect(r.start.map((x) => x.id)).toEqual(["b"]);
  });
  it("끼워 넣는 글: 추가 지시임을 알리고, 나눠 받은 몫이 다르면 함께", () => {
    expect(extraText("버튼 색 바꿔", "버튼 색 바꿔")).toBe("[추가 지시] 버튼 색 바꿔");
    expect(extraText("버튼 색과 API 이름 바꿔", "API 이름만 바꿔")).toMatch(/\[추가 지시\] 버튼 색과 API 이름 바꿔[\s\S]*\[내 몫\] API 이름만 바꿔/);
  });
});

describe("에이전트 안내: 지시 범위", () => {
  it("범위 제한이 있으면 내 몫이 넘어도 그 범위까지만", () => {
    const o = { me: login, members: [pay, login], instruction: "기획만", together: true };
    for (const full of [true, false]) expect(teamPrompt({ ...o, full })).toMatch(/범위/);
  });
});

describe("작업 중 추가 지시: 순서", () => {
  it("앞 에이전트가 끝나야 하는 몫은 지금 끼워 넣거나 시작하지 않고 뒤로", () => {
    const r = routeExtra([{ id: "a", task: "기획서" }, { id: "b", task: "기획서 받고 구현" }, { id: "c", task: "x" }], (id) => id !== "c", ["a", "c"]);
    expect(r.interject.map((x) => x.id)).toEqual(["a"]);
    expect(r.start.map((x) => x.id)).toEqual(["c"]);
    expect(r.later.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("범위 밖 일은 요청으로 넘기지 않기", () => {
  it("범위 제한이 있으면 범위 밖 일은 '요청:'이 아니라 다음 단계로만 적으라고", () => {
    const o = { me: login, members: [pay, login], instruction: "기획만", together: true };
    for (const full of [true, false]) expect(teamPrompt({ ...o, full })).toMatch(/다음 단계/);
  });
});

describe("브리핑 담당이 있으면 보고 없이 인계만", () => {
  const o = { me: login, members: [pay, login], instruction: "로그인 화면 고쳐", together: true };
  it("quiet면 사용자에게 보고·요약하지 말고 인계만 쓰라고", () => {
    for (const full of [true, false]) {
      const p = teamPrompt({ ...o, full, quiet: true });
      expect(p).toMatch(/브리핑 담당/);
      expect(p).toMatch(/보고/);
      expect(p).toMatch(/### 인계/);
    }
  });
  it("quiet가 아니면 그런 말이 없다", () => {
    expect(teamPrompt({ ...o, full: true })).not.toMatch(/브리핑 담당/);
  });
});
