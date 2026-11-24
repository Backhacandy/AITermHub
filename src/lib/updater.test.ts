// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { upd, checkNow, installNow, installWhenIdle, resetForTest, type UpdateDeps } from "./updater.svelte";

const deps = (o: Partial<UpdateDeps> = {}): UpdateDeps => ({
  check: async () => null,
  install: async () => {},
  relaunch: async () => {},
  busy: () => false,
  ...o,
});

beforeEach(() => resetForTest());

describe("자동 업데이트", () => {
  it("확인하다 오류가 나면(네트워크 없음 등) 조용히 넘어간다", async () => {
    await expect(checkNow(deps({ check: async () => { throw new Error("offline"); } }))).resolves.toBe(false); // 앱을 멈추지 않고 실패만 알린다(곧 다시 확인)
    expect(upd.available).toBeNull();
  });

  it("새 버전이 있으면 알려 준다(바로 설치하지 않음)", async () => {
    const install = vi.fn(async () => {});
    await checkNow(deps({ check: async () => ({ version: "0.9.0-beta.2" }), install }));
    expect(upd.available).toBe("0.9.0-beta.2");
    expect(install).not.toHaveBeenCalled();
  });

  it("지금 설치를 누르면 설치하고 다시 시작한다", async () => {
    const install = vi.fn(async () => {});
    const relaunch = vi.fn(async () => {});
    await checkNow(deps({ check: async () => ({ version: "0.9.0-beta.2" }) }));
    await installNow(deps({ install, relaunch }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("일하는 세션이 있으면 '일이 끝난 뒤'로 미뤘다가, 끝나면 설치한다", async () => {
    vi.useFakeTimers();
    let working = true;
    const install = vi.fn(async () => {});
    const relaunch = vi.fn(async () => {});
    const d = deps({ check: async () => ({ version: "0.9.0-beta.2" }), install, relaunch, busy: () => working });
    await checkNow(d);
    installWhenIdle(d);
    expect(upd.deferred).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(install).not.toHaveBeenCalled();
    working = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

import { isBusy } from "./updater.svelte";
describe("일이 끝난 뒤 설치 — 무엇을 일로 세나", () => {
  it("답하는 중인 탭뿐 아니라 백그라운드 작업(빌드·개발 서버)도 일로 센다", () => {
    expect(isBusy({}, {})).toBe(false);
    expect(isBusy({ t1: true }, {})).toBe(true);
    expect(isBusy({}, { t2: true })).toBe(true);
  });
});

import { cancelDeferred } from "./updater.svelte";
describe("'일이 끝난 뒤'를 취소", () => {
  it("배너를 닫지 않고 다시 고를 수 있게 돌아간다(업데이트 알림은 남음)", async () => {
    vi.useFakeTimers();
    const install = vi.fn(async () => {});
    const d = deps({ check: async () => ({ version: "0.9.0-beta.2" }), install, busy: () => true });
    await checkNow(d);
    installWhenIdle(d);
    cancelDeferred();
    expect(upd.deferred).toBe(false);
    expect(upd.available).toBe("0.9.0-beta.2");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(install).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

import { installSteps } from "./updater.svelte";
describe("설치 순서: 설치 파일이 앱과 같이 꺼지지 않게", () => {
  it("다 받은 뒤에 Job 밖으로 풀고 설치한다", async () => {
    const log: string[] = [];
    await installSteps({
      download: async () => void log.push("download"),
      breakaway: async (on) => void log.push(`breakaway:${on}`),
      install: async () => void log.push("install"),
    });
    expect(log).toEqual(["download", "breakaway:true", "install"]);
  });
  it("받다가 실패하면 Job은 건드리지 않는다", async () => {
    const log: string[] = [];
    await expect(installSteps({
      download: async () => { throw new Error("net"); },
      breakaway: async (on) => void log.push(`breakaway:${on}`),
      install: async () => void log.push("install"),
    })).rejects.toThrow("net");
    expect(log).toEqual([]);
  });
  it("설치가 실패하면 원래대로 되돌린다(새 자식이 다시 Job 안으로)", async () => {
    const log: string[] = [];
    await expect(installSteps({
      download: async () => {},
      breakaway: async (on) => void log.push(`breakaway:${on}`),
      install: async () => { throw new Error("bad sig"); },
    })).rejects.toThrow("bad sig");
    expect(log).toEqual(["breakaway:true", "breakaway:false"]);
  });
});

import { watchLoop, RETRY_MS } from "./updater.svelte";
describe("업데이트 확인이 실패하면 곧 다시", () => {
  it("켜고 10초 뒤 확인, 실패하면 10분 뒤 다시, 되면 알린다", async () => {
    vi.useFakeTimers();
    resetForTest();
    let n = 0;
    const d: UpdateDeps = {
      check: async () => {
        n++;
        if (n === 1) throw new Error("offline");
        return { version: "9.9.9" };
      },
      install: async () => {},
      relaunch: async () => {},
      busy: () => false,
    };
    watchLoop(d);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(1);
    expect(upd.available).toBeNull();
    expect(RETRY_MS).toBe(10 * 60_000);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(n).toBe(2);
    expect(upd.available).toBe("9.9.9");
    resetForTest();
    vi.useRealTimers();
  });
  it("확인이 되면(새 버전 없음) 하루 뒤에 다시", async () => {
    vi.useFakeTimers();
    resetForTest();
    let n = 0;
    const d: UpdateDeps = { check: async () => (n++, null), install: async () => {}, relaunch: async () => {}, busy: () => false };
    watchLoop(d);
    await vi.advanceTimersByTimeAsync(10_000 + RETRY_MS);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(n).toBe(2);
    resetForTest();
    vi.useRealTimers();
  });
});
