// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createNetRetry, isNetError, retryDelay, NET_MAX } from "./netRetry";

describe("네트워크 오류 판별", () => {
  it("연결 끊김·시간 초과·서버 과부하는 이어서 할 오류", () => {
    for (const t of [
      "API Error: Connection error.",
      "API Error: Request timed out.",
      "request to https://api.anthropic.com/v1/messages failed, reason: getaddrinfo ENOTFOUND api.anthropic.com",
      "fetch failed",
      "read ECONNRESET",
      "socket hang up",
      "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}",
      "API Error: 503 Service Unavailable",
      "Unable to connect to API (ConnectionRefused)",
    ]) expect(isNetError(t), t).toBe(true);
  });
  it("한도·권한·일반 오류는 아님", () => {
    for (const t of ["Claude AI usage limit reached|1792399200", "API Error: 400 invalid_request_error", "API Error: 401 authentication_error", "도구 실행 실패", "", null])
      expect(isNetError(t as any), String(t)).toBe(false);
  });
  it("기다리는 시간은 늘어나다 5분에서 멈춘다", () => {
    expect(retryDelay(1)).toBe(15_000);
    expect(retryDelay(2)).toBe(30_000);
    expect(retryDelay(10)).toBe(300_000);
  });
});

describe("다시 연결되면 이어서", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(online = true) {
    let on = online;
    const subs: (() => void)[] = [];
    const notes: string[] = [];
    const retry = vi.fn(async () => {});
    const net = createNetRetry({
      retry,
      note: (t) => notes.push(t),
      online: () => on,
      onOnline: (cb) => {
        subs.push(cb);
        return () => subs.splice(subs.indexOf(cb), 1);
      },
    });
    const goOnline = () => {
      on = true;
      [...subs].forEach((f) => f());
    };
    return { net, retry, notes, goOnline };
  }

  it("연결돼 있으면 잠깐 기다렸다 이어서 보낸다", async () => {
    const { net, retry, notes } = setup(true);
    expect(net.fail()).toBe(true);
    expect(net.waiting).toBe(true);
    expect(notes[0]).toMatch(/1\/8/);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(net.waiting).toBe(false);
  });

  it("끊겨 있으면 다시 연결될 때까지 기다린다", async () => {
    const { net, retry, goOnline } = setup(false);
    net.fail();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(retry).not.toHaveBeenCalled();
    goOnline();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("성공하면 횟수를 처음부터, 정해진 횟수를 넘으면 포기", async () => {
    const { net, retry } = setup(true);
    for (let i = 0; i < NET_MAX; i++) {
      expect(net.fail()).toBe(true);
      await vi.advanceTimersByTimeAsync(300_000);
    }
    expect(retry).toHaveBeenCalledTimes(NET_MAX);
    expect(net.fail()).toBe(false);
    net.ok();
    expect(net.fail()).toBe(true);
  });

  it("사용자가 새로 보내거나 멈추면 기다리던 재시도를 취소", async () => {
    const { net, retry } = setup(true);
    net.fail();
    net.cancel();
    expect(net.waiting).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(retry).not.toHaveBeenCalled();
  });
});
