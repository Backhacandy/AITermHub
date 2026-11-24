// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { routeInstruction, roleSwitch, detectAreas, extractHandoff, rolePrompt, roleIntro, roleKey, trespass, DEFAULT_ROLES } from "./route";
import { userText } from "$lib/work/userText";
import { autoModel } from "./models";

describe("역할 판단(토큰 0)", () => {
  const R = DEFAULT_ROLES;
  it("멘션이 있으면 그 에이전트만", () => {
    expect(routeInstruction("@claude 버튼 색 바꿔", R)).toMatchObject({ order: ["claude"], text: "버튼 색 바꿔" });
    expect(routeInstruction("@코덱스 API 추가", R).order).toEqual(["codex"]);
    expect(routeInstruction("@claude @codex 같이 해", R).order).toEqual(["codex", "claude"]); // 백엔드 먼저
  });
  it("@지정이 없으면 단어와 상관없이 늘 둘 다(백엔드 먼저)", () => {
    expect(routeInstruction("로그인 화면 레이아웃 정리", R).order).toEqual(["codex", "claude"]);
    expect(routeInstruction("주문 API랑 DB 스키마 추가", R).order).toEqual(["codex", "claude"]);
    expect(routeInstruction("검색 기능 good", R).order).toEqual(["codex", "claude"]);
    expect(routeInstruction("버그 고쳐줘", R).order).toEqual(["codex", "claude"]);
  });
  it("역할을 바꾸면 순서도 따라간다", () => {
    const sw = { back: "claude", front: "codex" } as const;
    expect(routeInstruction("화면 고쳐", sw).order).toEqual(["claude", "codex"]);
  });
  it("역할 바꾸기 지시 감지", () => {
    expect(roleSwitch("역할 바꿔줘", R)).toEqual({ back: "claude", front: "codex" });
    expect(roleSwitch("이번엔 codex가 프론트 해", R)).toEqual({ front: "codex", back: "claude" });
    expect(roleSwitch("클로드는 백엔드", R)).toEqual({ back: "claude", front: "codex" });
    expect(roleSwitch("결제 기능 만들어", R)).toBeNull();
  });
});

describe("담당 영역 감지", () => {
  it("폴더 구조로 프론트/백엔드 나누기", () => {
    const a = detectAreas(["src/routes", "src/lib/components", "src-tauri", "docs"]);
    expect(a.front).toContain("src/routes/**");
    expect(a.back).toContain("src-tauri/**");
    expect(a.front.some((g) => g.includes("docs"))).toBe(false);
    expect(a.back).toContain("**/*.rs");
  });
});

describe("담당 영역 감지 — 안쪽 폴더", () => {
  it("frontend·android·sql 같은 이름이면 그 경로 그대로, 이미 잡힌 폴더 안쪽은 또 잡지 않는다", () => {
    const a = detectAreas(["example-android", "example-web", "example-web/frontend", "example-web/frontend/app", "example-web/src", "example-web/sql", "docs"]);
    expect(a.front).toContain("example-android/**");
    expect(a.front).toContain("example-web/frontend/**");
    expect(a.front).not.toContain("example-web/frontend/app/**");
    expect(a.back).toContain("example-web/sql/**");
    expect([...a.front, ...a.back].some((g) => g.startsWith("docs") || g.startsWith("example-web/src"))).toBe(false);
  });
});

describe("영역 침범 — 누가 고쳤나", () => {
  const areas = { front: ["web/**", "**/*.svelte"], back: ["server/**", "**/*.rs"] };
  it("내가 고친 파일 중 상대 영역이고 내 영역이 아닌 것", () => {
    // 기본 역할: Codex 백엔드, Claude 프론트
    expect(trespass(["server/a.rs", "web/b.svelte", "README.md"], "codex", DEFAULT_ROLES, areas)).toEqual(["web/b.svelte"]);
    expect(trespass(["web/x.ts", "server/y.rs"], "claude", DEFAULT_ROLES, areas)).toEqual(["server/y.rs"]);
    // 양쪽 모두에 걸리면(예: 프론트 폴더 안의 .rs) 침범 아님
    expect(trespass(["web/tool.rs"], "claude", DEFAULT_ROLES, areas)).toEqual([]);
  });
});

describe("인계 메모", () => {
  it("### 인계 섹션만", () => {
    expect(extractHandoff("작업했어요.\n\n### 인계\n- POST /api/pay {amount}\n- 응답 {txId}")).toBe("- POST /api/pay {amount}\n- 응답 {txId}");
    expect(extractHandoff("완료\n인계: GET /items 추가")).toBe("GET /items 추가");
  });
  it("여러 번 나오면 마지막 인계(한 차례 글을 모았을 때)", () => {
    const all = "1차 작업\n### 인계\n- 예전 메모\n\n빌드를 돌려 볼게요\n\n빌드 통과\n### 인계\n- 요청: @화면 버튼 연결";
    expect(extractHandoff(all)).toBe("- 요청: @화면 버튼 연결");
  });
  it("없으면 끝부분, 너무 길면 자름", () => {
    expect(extractHandoff("a\nb\nc")).toBe("a\nb\nc");
    expect(extractHandoff("### 인계\n" + "x".repeat(2000)).length).toBeLessThan(1000);
  });
  it("프롬프트에 역할·영역·메모가 들어간다", () => {
    const p = rolePrompt({ me: "claude", roles: DEFAULT_ROLES, areas: { front: ["src/routes/**"], back: ["src-tauri/**"] }, instruction: "결제 화면", memo: "POST /pay", both: true });
    expect(p).toMatch(/프론트 담당/);
    expect(p).toMatch(/Codex 영역\(수정 금지/);
    expect(p).toMatch(/POST \/pay/);
    expect(p).toMatch(/### 인계/);
    // 동시에 일하므로 기다리지 말고, 상대가 할 일은 "요청:" 줄로
    expect(p).toMatch(/동시에/);
    expect(p).toMatch(/기다리지 말고/);
    expect(p).toMatch(/요청:/);
  });
});

describe("멘션 약자", () => {
  const R = DEFAULT_ROLES;
  it("@cl / @co 같은 2자 이상 접두어", () => {
    expect(routeInstruction("@cl 버튼 고쳐", R)).toMatchObject({ order: ["claude"], text: "버튼 고쳐" });
    expect(routeInstruction("@co API 추가", R)).toMatchObject({ order: ["codex"], text: "API 추가" });
    expect(routeInstruction("@cla @cod 같이", R).order).toEqual(["codex", "claude"]);
    expect(routeInstruction("@CL 대문자도", R).order).toEqual(["claude"]);
  });
  it("한글 약자 @클 / @코", () => {
    expect(routeInstruction("@클 화면", R).order).toEqual(["claude"]);
    expect(routeInstruction("@코 서버", R).order).toEqual(["codex"]);
  });
  it("@c 처럼 모호하거나 다른 단어면 무시하고 그대로 둔다", () => {
    expect(routeInstruction("@c 이거 뭐야", R).text).toBe("@c 이거 뭐야");
    expect(routeInstruction("@cloud 설정 버그", R).text).toContain("@cloud");
  });
  it("역할 바꾸기도 약자로", () => {
    expect(roleSwitch("cl이 백엔드", R)).toEqual({ back: "claude", front: "codex" });
    expect(roleSwitch("co가 프론트", R)).toEqual({ front: "codex", back: "claude" });
  });
});

describe("자동 모델", () => {
  it("단순 지시는 중간 등급, 그 외는 최상위", () => {
    expect(autoModel("claude", "버튼 문구 오타 고쳐")).toBe("sonnet");
    expect(autoModel("codex", "주석 정리")).toBe("gpt-6.2-sol");
    expect(autoModel("claude", "결제 흐름 전체를 새로 설계해서 구현해줘")).toBe("opus");
    expect(autoModel("codex", "API 추가")).toBe("gpt-6.2-astra");
  });
  it("길면 키워드가 있어도 최상위", () => {
    expect(autoModel("claude", "오타 고쳐 ".repeat(40))).toBe("opus");
  });
});

describe("역할 안내는 한 번만", () => {
  const areas = { front: ["src/routes/**", "**/*.svelte"], back: ["src-tauri/**", "**/*.rs"] };
  it("짧은 프롬프트: 상대 영역 금지 한 줄 + 지시 + 인계 한 줄", () => {
    const full = rolePrompt({ me: "codex", roles: DEFAULT_ROLES, areas, instruction: "API 추가", both: false });
    const short = rolePrompt({ me: "codex", roles: DEFAULT_ROLES, areas, instruction: "API 추가", both: false, full: false });
    expect(short.length).toBeLessThan(full.length / 2);
    expect(short).toMatch(/백엔드 담당/);
    expect(short).toMatch(/Claude 영역\(src\/routes\/\*\*, \*\*\/\*\.svelte\)은 수정 금지/);
    expect(short).toMatch(/API 추가/);
    expect(short).toMatch(/### 인계/);
    expect(short).not.toMatch(/내 영역/);
    // 인계 메모·나눠 하기는 짧은 형식에도
    const s2 = rolePrompt({ me: "codex", roles: DEFAULT_ROLES, areas, instruction: "x", memo: "POST /pay", both: true, full: false });
    expect(s2).toMatch(/POST \/pay/);
    expect(s2).toMatch(/내 몫/);
    expect(s2).toMatch(/동시에/);
    expect(s2).toMatch(/요청:/);
    // 내 담당에 할 일이 없으면 바로 끝내라(동시에 보낼 때만)
    expect(s2).toMatch(/내 몫 없음/);
    expect(rolePrompt({ me: "codex", roles: DEFAULT_ROLES, areas, instruction: "x", both: false, full: false })).not.toMatch(/내 몫 없음/);
    // Codex에게는 패치 규칙(같은 파일은 한 패치에 한 번)
    expect(roleIntro("codex", DEFAULT_ROLES, areas)).toMatch(/apply_patch/);
    expect(roleIntro("claude", DEFAULT_ROLES, areas)).not.toMatch(/apply_patch/);
    expect(full.startsWith(roleIntro("codex", DEFAULT_ROLES, areas))).toBe(true);
  });
  it("역할·영역이 바뀌면 키가 바뀐다", () => {
    expect(roleKey(DEFAULT_ROLES, areas)).toBe(roleKey({ ...DEFAULT_ROLES }, { ...areas }));
    expect(roleKey(DEFAULT_ROLES, areas)).not.toBe(roleKey({ back: "claude", front: "codex" }, areas));
    expect(roleKey(DEFAULT_ROLES, areas)).not.toBe(roleKey(DEFAULT_ROLES, { ...areas, back: ["server/**"] }));
  });
});

describe("지난 대화 표시용 사용자 글", () => {
  const areas = { front: ["**/*.svelte"], back: ["**/*.rs"] };
  it("협업 안내문은 빼고 지시만", () => {
    expect(userText(rolePrompt({ me: "claude", roles: DEFAULT_ROLES, areas, instruction: "버튼 색\n두 줄", memo: "m", both: true }))).toBe("버튼 색\n두 줄");
    expect(userText(rolePrompt({ me: "claude", roles: DEFAULT_ROLES, areas, instruction: "짧게", both: false, full: false }))).toBe("짧게");
  });
  it("시스템이 넣은 메시지는 숨기고, 보통 글은 그대로", () => {
    expect(userText("<task-notification>\n<task-id>x</task-id>\n</task-notification>")).toBeNull();
    expect(userText("  <system-reminder>뭔가</system-reminder>")).toBeNull();
    expect(userText("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
    expect(userText("Caveat: The messages below were generated by the user while running local commands.")).toBeNull();
    expect(userText("그냥 질문이에요")).toBe("그냥 질문이에요");
  });
});
