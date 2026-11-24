// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { visibleItems, renderBlock, mergeReadme, dueDaily, prefKey, START, END, type ProjectInfo } from "./portfolio";

const P = (dir: string, extra: Partial<ProjectInfo> = {}): ProjectInfo => ({ dir, name: dir.split(/[\\/]/).pop()!, first: "2026-10-03", last: "2026-11-10", commits: 42, tech: ["Unity", "C#"], readme: "", ...extra });

describe("포트폴리오 목록", () => {
  it("보이기로 고른 것만, 이름·설명은 고친 대로, 최근에 손댄 것부터", () => {
    const scan = [P("C:\\Luck"), P("C:\\AITermHub", { last: "2026-11-11" }), P("C:\\Old", { last: "2026-01-02" })];
    const prefs = { [prefKey("C:\\Luck")]: { show: true, desc: "숫자 퍼즐 게임" }, [prefKey("C:\\Old")]: { show: true, name: "옛 게임" } };
    const items = visibleItems(scan, prefs);
    expect(items.map((i) => i.name)).toEqual(["Luck", "옛 게임"]);
    expect(items[0]).toMatchObject({ desc: "숫자 퍼즐 게임", period: "2026.10 ~ 2026.11", commits: 42 });
  });
  it("처음 보는 프로젝트(설정 없음)는 숨김", () => {
    expect(visibleItems([P("C:\\New")], {})).toEqual([]);
  });
  it("표로 그리고 | 는 깨지지 않게", () => {
    const b = renderBlock([{ dir: "x", name: "A|B", desc: "설명 | 둘", period: "2026.10", tech: ["Rust"], commits: 3 }], "2026-11-11");
    expect(b.startsWith(START)).toBe(true);
    expect(b.endsWith(END)).toBe(true);
    expect(b).toContain("| A\\|B | 설명 \\| 둘 | 2026.10 | Rust | 3 |");
  });
  it("README 합치기: 표시 사이만 바꾸고 나머지는 그대로, 없으면 덧붙이거나 새로", () => {
    const block = `${START}\n새 목록\n${END}`;
    expect(mergeReadme(`# 나\n소개\n${START}\n옛 목록\n${END}\n끝`, block, "me")).toBe(`# 나\n소개\n${block}\n끝`);
    expect(mergeReadme("# 나\n소개", block, "me")).toBe(`# 나\n소개\n\n${block}\n`);
    expect(mergeReadme("", block, "me")).toBe(`# me\n\n${block}\n`);
  });
  it("하루에 한 번", () => {
    expect(dueDaily(undefined, 1000)).toBe(true);
    expect(dueDaily(0, 24 * 3600_000 - 1)).toBe(false);
    expect(dueDaily(0, 24 * 3600_000)).toBe(true);
  });
});

import { planPublish } from "./portfolio";
describe("README를 망가뜨리지 않기", () => {
  it("시작 표시만 있고 끝 표시가 없으면(또는 끝이 앞에 있으면) 고치지 않고 멈춘다", () => {
    const block = `${START}\n새\n${END}`;
    expect(() => mergeReadme(`# 나\n${START}\n내 소개\n## 연락처`, block, "me")).toThrow(/표시/);
    expect(() => mergeReadme(`# 나\n${END}\n소개\n${START}\n옛`, block, "me")).toThrow(/표시/);
  });
  it("보일 게 없으면: 이미 올린 목록이 있으면 비워서 올리고, 없으면 올리지 않음", () => {
    expect(planPublish(0, `${START}\n옛 목록\n${END}`, "x")).toBe("write");
    expect(planPublish(0, "# 나", "x")).toBe("skip");
    expect(planPublish(0, "", "x")).toBe("skip");
  });
  it("날짜만 다르고 목록이 같으면 올리지 않음(매일 커밋 안 쌓이게)", () => {
    const a = renderBlock([{ dir: "x", name: "A", desc: "", period: "", tech: [], commits: 1 }], "2026-11-10");
    const b = renderBlock([{ dir: "x", name: "A", desc: "", period: "", tech: [], commits: 1 }], "2026-11-11");
    expect(planPublish(1, `# 나\n${a}\n`, b)).toBe("same");
    expect(planPublish(1, `# 나\n${a}\n`, b.replace("| 1 |", "| 2 |"))).toBe("write");
  });
});
