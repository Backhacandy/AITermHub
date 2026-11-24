// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { allocationRows, confirmFrom, openConfirm, supersede, chatKey, loadChat, saveChat, branchConfirm, prConfirm, proposeBranch, type ChatMsg, type ConfirmReq } from "./leadChat";
import { migrateTeam, planActions, parseLeadReply } from "./leadAgent";
import type { Member } from "./team";

const W = (id: string, name: string): Member => ({ id, name, cli: "claude", model: "sonnet", purpose: `${name} 일`, areas: [] });
const team = migrateTeam([W("m1", "기획"), W("m2", "UI")]).members;
const reply = parseLeadReply(
  '배치예요\n```aith-lead\n{"wait":true,"actions":[{"type":"create","name":"QA","cli":"claude","model":"sonnet","purpose":"테스트","areas":[]},{"type":"role","name":"UI","purpose":"UI + 효과음"},{"type":"assign","to":"UI","task":"시작 씬"},{"type":"assign","to":"QA","task":"흐름 검증","after":["UI"]}]}\n```',
);
const plan = planActions(team, reply.actions, 8);

const mem = () => {
  const s: Record<string, string> = {};
  return { getItem: (k: string) => s[k] ?? null, setItem: (k: string, v: string) => void (s[k] = v), s };
};

describe("확인 요청", () => {
  it("배치표: 맡을 일과 새로 만듦·역할 바꿈 표시", () => {
    expect(allocationRows(plan, team)).toEqual([
      { name: "UI", task: "시작 씬", change: "역할 바꿈" },
      { name: "QA", task: "흐름 검증", change: "새로 만듦" },
    ]);
  });

  it("확인하면 실행할 행동을 함께 담는다", () => {
    const c = confirmFrom(reply, plan, team, "allocation", "c1");
    expect(c).toMatchObject({ id: "c1", kind: "allocation", title: "배치 확인", state: "open" });
    expect(c.actions).toEqual(reply.actions);
    const p = confirmFrom({ say: "주제는 X", wait: false, actions: [], confirm: { kind: "plan", title: "", body: "기획 요약", files: ["Docs/GDD.md"] } }, planActions(team, [], 8), team, "plan", "c2");
    expect(p).toMatchObject({ title: "기획 확인", body: "기획 요약", files: ["Docs/GDD.md"] });
  });

  it("열린 확인 요청은 가장 최근 것", () => {
    const a = confirmFrom(reply, plan, team, "allocation", "a");
    const b = { ...confirmFrom(reply, plan, team, "allocation", "b"), state: "ok" as const };
    const msgs: ChatMsg[] = [
      { key: "1", role: "lead", text: "", at: 1, confirm: a },
      { key: "2", role: "lead", text: "", at: 2, confirm: b },
    ];
    expect(openConfirm(msgs)?.id).toBe("a");
    expect(openConfirm([])).toBeNull();
  });

  // 결과가 잇달아 들어오면 팀장이 배치 확인을 한 번 더 내서, 열린 카드가 둘 겹쳤다(MyTeam, 58초 간격)
  it("새 확인 요청이 오면 같은 갈래의 열린 카드는 닫는다", () => {
    const card = (id: string, kind: ConfirmReq["kind"]) =>
      ({ key: id, role: "lead" as const, text: "", at: 1, confirm: { ...confirmFrom(reply, plan, team, "allocation", id), kind } });
    const msgs: ChatMsg[] = [card("p", "plan"), card("a", "allocation"), card("m", "merge"), card("r", "pr")];
    msgs[0].confirm!.state = "ok";
    expect(supersede(msgs, "allocation")).toBe(1);
    expect(msgs.map((m) => m.confirm!.state)).toEqual(["ok", "dropped", "open", "open"]);
    expect(supersede(msgs, "other")).toBe(0); // 팀장 제안끼리(plan·allocation·other)는 한 갈래
    expect(supersede(msgs, "merge")).toBe(1);
    expect(msgs[3].confirm!.state).toBe("open"); // 다른 갈래(pr)는 그대로
  });
});

describe("대화 기록", () => {
  it("폴더별로 저장하고 다시 켜도 확인 대기 배치가 그대로", () => {
    const st = mem();
    const c = confirmFrom(reply, plan, team, "allocation", "c1");
    saveChat(st, "C:\\Luck\\", [{ key: "1", role: "lead", text: "배치예요", at: 1, confirm: c }]);
    expect(chatKey("c:/luck")).toBe(chatKey("C:\\Luck\\"));
    const back = loadChat(st, "c:/luck");
    expect(back[0].confirm?.actions).toEqual(reply.actions);
    expect(openConfirm(back)?.id).toBe("c1");
  });

  it("200개까지만, 저장소가 없거나 깨져도 빈 목록", () => {
    const st = mem();
    const many: ChatMsg[] = Array.from({ length: 230 }, (_, i) => ({ key: String(i), role: "user", text: `${i}`, at: i }));
    saveChat(st, "D:/p", many);
    const back = loadChat(st, "D:/p");
    expect(back.length).toBe(200);
    expect(back[0].text).toBe("30");
    expect(loadChat(undefined, "D:/p")).toEqual([]);
    st.setItem(chatKey("D:/x"), "{깨짐");
    expect(loadChat(st, "D:/x")).toEqual([]);
  });
});

describe("탭마다 따로", () => {
  it("같은 폴더라도 팀(대화 id)이 다르면 기록이 섞이지 않는다", () => {
    expect(chatKey("C:/Luck", "a")).not.toBe(chatKey("C:/Luck", "b"));
    expect(chatKey("C:\\Luck\\", "a")).toBe(chatKey("c:/luck", "a"));
  });
});

import { CONFIRM_BUTTONS, mergeConfirm, gitConfirm } from "./leadChat";
describe("확인 카드 종류", () => {
  it("종류마다 버튼 글자", () => {
    expect(CONFIRM_BUTTONS.merge).toEqual(["합치기", "나중에"]);
    expect(CONFIRM_BUTTONS.git).toEqual(["git 저장소 만들기", "같은 폴더에서 일하기"]);
    expect(CONFIRM_BUTTONS.plan).toEqual(["확인하고 진행", "고칠래요"]);
  });
  it("합치기 확인과 대기", () => {
    const c = mergeConfirm("m1", [{ name: "UI", stat: "2 files changed" }], false);
    expect(c).toMatchObject({ id: "m1", kind: "merge", title: "합치기 확인", state: "open", rows: [{ name: "UI", task: "2 files changed" }] });
    const d = mergeConfirm("m2", [], true);
    expect(d.title).toBe("합치기 대기");
    expect(d.body).toMatch(/직접 고친/);
    // 대기 카드: 누르면 겹치는 변경을 보관(stash)하고 합친다 — 같은 카드가 되풀이되며 안 합쳐지지 않게
    expect(d).toMatchObject({ stash: true, buttons: ["보관하고 합치기", "나중에"] });
    expect(c.stash).toBeUndefined();
  });
  it("git 만들기 카드는 미뤄 둔 배치를 담는다", () => {
    const acts = [{ type: "assign" as const, to: "UI", task: "t" }];
    expect(gitConfirm("g1", acts, "지시")).toMatchObject({ id: "g1", kind: "git", actions: acts, instruction: "지시", state: "open" });
  });
});

describe("합치기 대기 카드", () => {
  it("무엇 때문에 기다리는지 파일을 보여 준다", () => {
    const c = mergeConfirm("w1", [], true, ["Assets/Scripts/A.cs", "ProjectSettings/x.asset"]);
    expect(c.files).toEqual(["Assets/Scripts/A.cs", "ProjectSettings/x.asset"]);
    expect(c.body).toMatch(/2개/);
  });
});

describe("공유 저장소 카드", () => {
  it("작업 브랜치 이름에는 앱 이름이 없다", () => {
    expect(proposeBranch(new Date(2026, 10, 12, 9, 5))).toBe("feature/team-1112-0905");
  });
  it("기본 브랜치면 새 브랜치를 만들지 묻는다", () => {
    const c = branchConfirm("b1", "master", "feature/team-1112-0905", "example-user/example-web");
    expect(c).toMatchObject({ kind: "branch", branch: "feature/team-1112-0905", state: "open" });
    expect(c.body).toContain("master");
    expect(CONFIRM_BUTTONS.branch[0]).toContain("브랜치");
  });
  it("올리기 카드는 제목·설명·fork 여부를 보여 주고 누를 때만", () => {
    const c = prConfirm("p1", { branch: "feature/frontend", base: "master", repo: "example-user/example-web", fork: false, title: "feat: 로그인", body: "설명" });
    expect(c).toMatchObject({ kind: "pr", pr: { branch: "feature/frontend", title: "feat: 로그인", body: "설명", github: true }, state: "open" });
    expect(c.buttons).toBeUndefined();
    const gl = prConfirm("p3", { branch: "x", base: "", repo: "원격 저장소", fork: false, title: "t", body: "", github: false });
    expect(gl.buttons?.[0]).toBe("push하기");
    expect(gl.pr?.github).toBe(false);
    expect(c.body).toContain("feature/frontend → master (example-user/example-web)");
    expect(c.body).not.toContain("fork");
    expect(prConfirm("p2", { branch: "x", base: "", repo: "a/b", fork: true, title: "t", body: "" }).body).toContain("fork");
  });
});
