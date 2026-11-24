// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { recommend, skillsFor, searchCatalog, searchSkills, directOf, type Scan, type CatalogItem } from "./match";

const C = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({ name, market: "claude-plugins-official", description: `${name} desc`, category: "development", installs: 10, always_on: 1000, skills: [], ...extra });
const base = (over: Partial<Scan> = {}): Scan => ({
  signals: [],
  claude_md_bytes: 0,
  has_git: false,
  transcript_bytes: 0,
  catalog: [C("superpowers"), C("unity", { skills: ["unity-cli"] }), C("csharp-lsp"), C("rust-analyzer-lsp"), C("typescript-lsp"), C("frontend-design"), C("context7"), C("commit-commands"), C("claude-md-management"), C("playwright")],
  installed: [],
  enabled: [],
  skills: [],
  ...over,
});

describe("플러그인 추천", () => {
  it("설치 안 된 것 중 이 프로젝트에 맞는 걸 먼저(프로젝트 전용이 공통보다 앞)", () => {
    const r = recommend(base({ signals: ["unity", "csharp"] }));
    const names = r.missing.map((x) => x.name);
    expect(names.slice(0, 2)).toEqual(["unity", "csharp-lsp"]);
    expect(names).toContain("superpowers");
    expect(names).not.toContain("rust-analyzer-lsp");
    expect(r.missing[0].why).toMatch(/Unity/);
    expect(r.missing[0].skills).toEqual(["unity-cli"]);
  });

  it("깔려 있고 켜진 건 '쓰는 중', 깔렸지만 꺼진 건 '꺼져 있음'으로 따로", () => {
    const r = recommend(base({ signals: ["rust"], installed: ["superpowers@claude-plugins-official", "rust-analyzer-lsp@claude-plugins-official"], enabled: ["superpowers@claude-plugins-official"] }));
    expect(r.on.map((x) => x.name)).toEqual(["superpowers"]);
    expect(r.off.map((x) => x.name)).toEqual(["rust-analyzer-lsp"]);
    expect(r.missing.map((x) => x.name)).not.toContain("superpowers");
  });

  it("목록에 없는 플러그인은 추천하지 않는다", () => {
    const r = recommend(base({ signals: ["go"] }));
    expect(r.missing.map((x) => x.name)).not.toContain("gopls-lsp");
  });

  it("웹 화면 프로젝트면 화면 관련, git이면 커밋 도구, CLAUDE.md가 있으면 관리 도구", () => {
    const r = recommend(base({ signals: ["svelte", "typescript"], has_git: true, claude_md_bytes: 100 }));
    const names = r.missing.map((x) => x.name);
    for (const n of ["typescript-lsp", "frontend-design", "playwright", "commit-commands", "claude-md-management"]) expect(names).toContain(n);
  });
});

describe("설치된 스킬 중 쓸 만한 것", () => {
  it("프로젝트 신호와 맞는 스킬, 그다음 늘 쓸 만한 스킬", () => {
    const skills = [
      { name: "unity-cli", description: "Use when interacting with Unity CLI", plugin: "unity" },
      { name: "systematic-debugging", description: "Use when encountering any bug", plugin: "superpowers" },
      { name: "pptx", description: "slides", plugin: null },
    ];
    const r = skillsFor(base({ signals: ["unity"], skills }));
    expect(r.map((x) => x.name)).toEqual(["unity-cli", "systematic-debugging"]);
  });
});

describe("전체 목록에서 찾기", () => {
  it("이름·설명으로, 설치 상태와 함께", () => {
    const s = base({ installed: ["playwright@claude-plugins-official"], enabled: ["playwright@claude-plugins-official"] });
    expect(searchCatalog(s, "play").map((x) => [x.name, x.state])).toEqual([["playwright", "on"]]);
    expect(searchCatalog(s, " ")).toEqual([]);
  });

  it("스킬 이름·여러 낱말로도 찾고, 이름에 맞은 게 먼저", () => {
    const s = base({ catalog: [C("game-kit", { description: "tools for unity games" }), C("unity", { skills: ["unity-cli"] }), C("other", { skills: ["unity-cli-helper"] })] });
    expect(searchCatalog(s, "unity")[0].name).toBe("unity");
    expect(searchCatalog(s, "unity-cli").map((x) => x.name)).toEqual(["unity", "other"]);
    expect(searchCatalog(s, "unity games").map((x) => x.name)).toEqual(["game-kit"]);
  });

  it("설치된 스킬에서도 찾는다", () => {
    const s = base({ skills: [{ name: "pptx", description: "make slides", plugin: null }, { name: "tdd", description: "tests", plugin: "superpowers" }] });
    expect(searchSkills(s, "slides").map((k) => k.name)).toEqual(["pptx"]);
    expect(searchSkills(s, "superpowers").map((k) => k.name)).toEqual(["tdd"]);
  });
});

describe("목록에 없는 것 바로 쓰기", () => {
  it("이름@마켓은 플러그인 설치, owner/repo·URL·경로는 마켓 추가, 그 밖은 없음", () => {
    expect(directOf(" foo@my-market ")).toEqual({ kind: "plugin", id: "foo@my-market" });
    expect(directOf("anthropics/skills")).toEqual({ kind: "market", source: "anthropics/skills" });
    expect(directOf("https://github.com/a/b.git")).toEqual({ kind: "market", source: "https://github.com/a/b.git" });
    expect(directOf("C:\\plugins\\mine")).toEqual({ kind: "market", source: "C:\\plugins\\mine" });
    expect(directOf("unity")).toBeNull();
    expect(directOf("unity games")).toBeNull();
  });
});
