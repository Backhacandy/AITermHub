// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { freedOnSleep, addSample, shouldAsk, fmtGB, EMPTY, type ThanksState } from "./thanks";

const MB = 1024 * 1024;
const st = (suspended: boolean, rss: number) => ({ suspended, rss });

describe("잠들 때 돌려받은 메모리", () => {
  it("깨어 있다가 잠든 순간에만, 줄어든 만큼을 센다", () => {
    expect(freedOnSleep(st(false, 300 * MB), st(true, 40 * MB))).toBe(260 * MB);
  });
  it("이미 자고 있었거나, 깨어 있는 중이거나, 처음 보는 탭이면 0", () => {
    expect(freedOnSleep(st(true, 300 * MB), st(true, 40 * MB))).toBe(0);
    expect(freedOnSleep(st(false, 300 * MB), st(false, 40 * MB))).toBe(0);
    expect(freedOnSleep(undefined, st(true, 40 * MB))).toBe(0);
  });
  it("잠들었는데 오히려 늘었으면 0(음수로 빼지 않는다)", () => {
    expect(freedOnSleep(st(false, 40 * MB), st(true, 60 * MB))).toBe(0);
  });
});

describe("쌓기와 부탁할 때", () => {
  it("잠든 횟수와 돌려받은 양을 쌓는다", () => {
    let s: ThanksState = { ...EMPTY };
    s = addSample(s, 260 * MB);
    s = addSample(s, 0); // 잠든 게 아니면 그대로
    s = addSample(s, 140 * MB);
    expect(s).toEqual({ sleeps: 2, freed: 400 * MB, asked: false });
  });
  it("3번 이상 재우고 300MB 이상 돌려받았을 때 딱 한 번만 부탁한다", () => {
    expect(shouldAsk({ sleeps: 2, freed: 900 * MB, asked: false })).toBe(false);
    expect(shouldAsk({ sleeps: 3, freed: 200 * MB, asked: false })).toBe(false);
    expect(shouldAsk({ sleeps: 3, freed: 300 * MB, asked: false })).toBe(true);
    expect(shouldAsk({ sleeps: 9, freed: 3000 * MB, asked: true })).toBe(false);
  });
  it("사람이 읽기 좋게: 1GB 미만은 MB, 이상은 소수 한 자리 GB", () => {
    expect(fmtGB(420 * MB)).toBe("420MB");
    expect(fmtGB(1536 * MB)).toBe("1.5GB");
  });
});
