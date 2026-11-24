// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { isLimitError, moved, canDisable, toLimits, fromLimits, isExhausted, dueForRefresh, nextUsableAt, type Account } from "./accounts.svelte";

const A = (id: string, cli: "claude" | "codex", enabled = true): Account => ({ id, cli, home: null, enabled, loggedIn: true });

describe("계정 풀 규칙", () => {
  it("한도 소진 오류 문구", () => {
    expect(isLimitError("Claude AI usage limit reached|1792399200")).toBe(true);
    expect(isLimitError("You've hit your usage limit. Upgrade to Pro")).toBe(true);
    expect(isLimitError("stream error: rate_limit_exceeded")).toBe(true);
    // 2026-10 Claude 문구: 5시간 한도는 "session limit", 주간은 "weekly limit"
    expect(isLimitError("You've hit your session limit · resets 3:40pm (Asia/Seoul)")).toBe(true);
    expect(isLimitError("You've hit your weekly limit · resets Oct 25")).toBe(true);
    expect(isLimitError("You've hit your Opus limit")).toBe(true);
    expect(isLimitError("세션을 찾을 수 없어요(session not found)")).toBe(false);
    expect(isLimitError("파일을 찾을 수 없어요")).toBe(false);
    expect(isLimitError("")).toBe(false);
  });
  it("같은 CLI 묶음 안에서만 순서를 바꾼다", () => {
    const l = [A("c1", "claude"), A("x1", "codex"), A("c2", "claude"), A("x2", "codex")];
    expect(moved(l, "c2", -1)).toEqual(["c2", "x1", "c1", "x2"]);
    expect(moved(l, "x1", 1)).toEqual(["c1", "x2", "c2", "x1"]);
    expect(moved(l, "c1", -1)).toEqual(["c1", "x1", "c2", "x2"]); // 맨 위는 그대로
  });
  it("켜진 계정은 최소 하나", () => {
    const l = [A("c1", "claude"), A("c2", "claude", false), A("x1", "codex")];
    expect(canDisable(l, "c1")).toBe(false);
    expect(canDisable(l, "x1")).toBe(false);
    expect(canDisable([A("c1", "claude"), A("c2", "claude")], "c1")).toBe(true);
  });
  it("한도 단위 변환(초 ↔ ms)과 소진 판정", () => {
    const lim = toLimits({ five: { pct: 40, resetsAt: 100 }, week: { pct: 100, resetsAt: 200 } })!;
    expect(lim.fiveHour).toEqual({ pct: 40, resetsAt: 100_000 });
    expect(fromLimits(lim).week).toEqual({ pct: 100, resetsAt: 200 });
    const a: Account = { ...A("c1", "claude"), limits: { week: { pct: 100, resetsAt: 200 } } };
    expect(isExhausted(a, 150)).toBe(true);
    expect(isExhausted(a, 250)).toBe(false);
    expect(isExhausted({ ...A("c1", "claude"), exhaustedUntil: 300 }, 250)).toBe(true);
  });
});

describe("작업 중 사용량 자동 갱신", () => {
  const A = (id: string, cli: "claude" | "codex", checkedAt?: number) => ({ id, cli, enabled: true, loggedIn: true, home: null, limits: checkedAt ? { checkedAt } : undefined }) as unknown as Account;
  it("지금 쓰는 계정 중 오래 확인 안 한 것만(Claude 10분·Codex 5분)", () => {
    const now = 100_000;
    const list = [A("cl", "claude", now - 9 * 60), A("cl2", "claude", 0), A("cx", "codex", now - 6 * 60)];
    expect(dueForRefresh(list, { claude: "cl", codex: "cx" }, now)).toEqual(["cx"]);
    expect(dueForRefresh(list, { claude: "cl2" }, now)).toEqual(["cl2"]);
    expect(dueForRefresh(list, { claude: "cl" }, now + 60)).toEqual(["cl"]);
    expect(dueForRefresh(list, {}, now)).toEqual([]);
  });
});

describe("한도 소진 판정", () => {
  it("거절 신호가 있어도 로그인·네트워크 오류는 소진이 아니다", async () => {
    const { limitHit } = await import("./accounts.svelte");
    expect(limitHit(true, "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare")).toBe(false);
    expect(limitHit(true, "API Error: 401 OAuth access token has expired")).toBe(false);
    expect(limitHit(true, "Claude AI usage limit reached|1794708000")).toBe(true);
    expect(limitHit(false, "You've hit your weekly limit")).toBe(true);
    expect(limitHit(true, "API Error: 529 overloaded")).toBe(false); // 과부하는 잠깐 — 네트워크처럼 다시 시도
    expect(limitHit(true, "Request rejected")).toBe(true);
    expect(limitHit(false, "Failed to authenticate. API Error: 403")).toBe(false);
  });
});

describe("한도가 다 됐을 때 언제 다시 쓸 수 있나", () => {
  const base = (o: Partial<Account>): Account => ({ id: "a", cli: "claude", home: null, enabled: true, loggedIn: true, ...o });
  it("쓸 수 있는 계정이 있으면 지금", () => {
    expect(nextUsableAt([base({})], "claude", 1000)).toBe(1000);
  });
  it("모두 막혔으면 가장 먼저 풀리는 시각(찬 창의 초기화·막아 둔 시각 중 늦은 것)", () => {
    const a = base({ id: "a", exhaustedUntil: 5000 });
    const b = base({ id: "b", limits: { five: { pct: 100, resetsAt: 3000 }, week: { pct: 100, resetsAt: 9000 } } });
    expect(nextUsableAt([a, b], "claude", 1000)).toBe(5000);
  });
  it("꺼진·로그인 안 된·다른 CLI 계정은 보지 않고, 모르면 null", () => {
    expect(nextUsableAt([base({ enabled: false }), base({ cli: "codex" })], "claude", 1000)).toBeNull();
    expect(nextUsableAt([base({ limits: { five: { pct: 100, resetsAt: null } } })], "claude", 1000)).toBeNull();
  });
});

import { vi, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
import { invoke } from "@tauri-apps/api/core";
import { createRotator } from "./accounts.svelte";
afterEach(() => vi.unstubAllEnvs());

describe("배포판: 계정 자동 전환 없음", () => {
  it("한도가 다 돼도 다른 계정으로 바꾸지 않고, 계정을 소진 처리하지도 않는다", async () => {
    vi.stubEnv("VITE_FLAVOR", "release");
    vi.mocked(invoke).mockClear();
    const r = createRotator("claude");
    expect(await r.next(123)).toBeNull();
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain("accounts_exhaust");
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain("accounts_pick");
  });
});
