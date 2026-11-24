// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authKind, createAuthWaiter } from "./authWait";

describe("인증 오류 판별", () => {
  it("취소·갱신 실패·로그인 만료는 다시 로그인을 기다린다", () => {
    for (const t of [
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Login expired · Please run /login",
      "Invalid API key · Please run /login",
    ]) expect(authKind(t), t).toBe("login");
  });
  it("액세스 토큰 만료만이면 다시 시작하면 스스로 갱신한다", () => {
    expect(authKind('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}')).toBe("expired");
  });
  it("그 밖의 오류는 아님", () => {
    for (const t of ["Claude AI usage limit reached|1792399200", "API Error: Connection error.", "", null]) expect(authKind(t as any), String(t)).toBe(null);
  });
});

describe("다시 로그인하면 모두 이어서", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    let stamp: number | null = 1000;
    const opened: (string | null)[] = [];
    const alerts: string[] = [];
    const w = createAuthWaiter({
      stamp: async () => stamp,
      openLogin: (a) => opened.push(a),
      alert: (t) => alerts.push(t),
      now: () => Date.now(),
      pollMs: 10_000,
      staggerMs: 2_000,
    });
    return { w, opened, alerts, relogin: (t: number) => (stamp = t) };
  }

  it("로그인 창은 한 번만 열고, 로그인 파일이 새로 바뀌면 기다리던 세션을 차례로 이어서", async () => {
    vi.setSystemTime(5000);
    const { w, opened, alerts, relogin } = setup();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    w.wait("acc", "login", a);
    w.wait("acc", "login", b);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toEqual(["acc"]);
    expect(alerts).toHaveLength(1);
    expect(w.lost).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a).not.toHaveBeenCalled();
    relogin(90_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled(); // 한꺼번에 갱신하지 않게 간격을 두고
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b).toHaveBeenCalledTimes(1);
    expect(w.lost).toBe(false);
  });

  it("액세스 토큰 만료만이면 로그인 창 없이 잠시 뒤 다시", async () => {
    const { w, opened } = setup();
    const a = vi.fn(async () => {});
    w.wait("acc", "expired", a);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened).toEqual([]);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("취소하면 다시 시작하지 않는다", async () => {
    vi.setSystemTime(5000);
    const { w, relogin } = setup();
    const a = vi.fn(async () => {});
    const cancel = w.wait("acc", "login", a);
    cancel();
    relogin(90_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a).not.toHaveBeenCalled();
  });
});
