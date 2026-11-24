// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { dueDirs, GRASS_GAP_MS, parseDirs } from "./grass";

describe("잔디 자동 올리기 차례", () => {
  const now = Date.parse("2026-11-08T20:00:00+09:00");
  it("한 번도 안 했거나 마지막 자동 커밋에서 3시간이 지난 폴더만", () => {
    const last = { "C:\\a": now - GRASS_GAP_MS + 60_000, "C:\\b": now - GRASS_GAP_MS - 1 };
    expect(dueDirs(["C:\\a", "C:\\b", "C:\\c"], last, now)).toEqual(["C:\\b", "C:\\c"]);
  });
  it("폴더 목록 글: 줄마다 하나, 빈 줄·중복·앞뒤 공백 정리", () => {
    expect(parseDirs(" C:\\MonsterGame \n\nC:\\MonsterGame\nD:\\x\\y\\ ")).toEqual(["C:\\MonsterGame", "D:\\x\\y"]);
  });
});

import { migrateGrassDirs } from "./grass";
describe("잔디 폴더 옮기기", () => {
  it("설정에 폴더가 없으면 지금까지 잔디를 올린 폴더 기록에서 가져온다(있으면 그대로)", () => {
    expect(migrateGrassDirs(undefined, { "C:\\B": 2, "C:\\A": 1 })).toEqual(["C:\\A", "C:\\B"]);
    expect(migrateGrassDirs(["D:\\X"], { "C:\\A": 1 })).toEqual(["D:\\X"]);
    expect(migrateGrassDirs(undefined, {})).toEqual([]);
  });
});
