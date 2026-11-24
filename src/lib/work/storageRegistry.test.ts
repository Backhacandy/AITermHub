// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { register, collect, noteFor } from "./storageRegistry";

const P = (repos: string[], o: Partial<{ skipWts: string[]; skipLanes: string[]; keepIds: string[]; note: (t: string) => void }> = {}) => ({
  repos: () => repos,
  skipWts: () => o.skipWts ?? [],
  skipLanes: () => o.skipLanes ?? [],
  keepIds: () => o.keepIds ?? [],
  note: o.note,
});

describe("storageRegistry", () => {
  it("열린 탭들이 알려 준 것을 겹치지 않게 모은다", () => {
    const off1 = register("a", P(["C:/P"], { keepIds: ["x"], skipLanes: ["a~m1"] }));
    const off2 = register("b", P(["C:/P", "D:/Q"], { keepIds: ["x", "y"], skipWts: ["C:/P/.aith/wt/t-t1-m1"] }));
    const c = collect();
    expect(c.repos.sort()).toEqual(["C:/P", "D:/Q"]);
    expect(c.keepIds.sort()).toEqual(["x", "y"]);
    expect(c.skipLanes).toEqual(["a~m1"]);
    expect(c.skipWts).toEqual(["C:/P/.aith/wt/t-t1-m1"]);
    off1();
    off2();
    expect(collect().repos).toEqual([]);
  });

  it("정리 결과는 그 폴더를 가진 탭에 알린다(대소문자·구분자 무시)", () => {
    const got: string[] = [];
    const off = register("t", P(["C:\\MyNovel"], { note: (t) => got.push(t) }));
    noteFor("c:/mynovel/.aith/wt/t-x-m1")?.("비움");
    expect(got).toEqual(["비움"]);
    expect(noteFor("C:/Other/.aith/wt/t-x-m1")).toBeUndefined();
    off();
  });
});
