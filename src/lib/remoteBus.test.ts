// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
import { registerTab, findHandle, handle, changedSince, statusText, setTabCheck, __wrapStoreForTest } from "./remoteBus.svelte";
import { beforeEach } from "vitest";

const acks = () => {
  const got: string[] = [];
  return { got, ack: async (a: string) => void got.push(a) };
};

beforeEach(() => setTabCheck(() => true));

describe("닫은 탭의 핸들", () => {
  // 실제 앱에서는 $state가 저장 값을 프록시로 바꿔 `저장값 === h`가 늘 거짓 → 해제가 안 됐다(테스트는 서버 컴파일이라 못 잡음)
  it("등록한 값이 다른 객체로 바뀌어 저장돼도(프록시) 해제하면 없어진다", () => {
    __wrapStoreForTest((h) => ({ ...h }));
    const off = registerTab("w1", { kind: "pair", cwd: "C:\\W", running: () => false, last: () => "" });
    expect(findHandle("pair", "C:\\W")?.[0]).toBe("w1");
    off();
    expect(findHandle("pair", "C:\\W")).toBeUndefined();
    __wrapStoreForTest(null);
  });

  it("tabs에 없는 id의 핸들은 찾지 않는다", () => {
    const off = registerTab("gone", { kind: "pair", cwd: "C:\\G", running: () => false, last: () => "" });
    setTabCheck((id) => id !== "gone");
    expect(findHandle("pair", "C:\\G")).toBeUndefined();
    off();
  });
});

describe("remoteBus", () => {
  it("폴더(대소문자·끝 슬래시 무시)와 종류로 탭을 찾는다", () => {
    const off = registerTab("t1", { kind: "codex", cwd: "C:\\Proj", running: () => false, last: () => "" });
    expect(findHandle("codex", "c:\\proj\\")?.[0]).toBe("t1");
    expect(findHandle("pair", "C:\\Proj")).toBeUndefined();
    off();
    expect(findHandle("codex", "C:\\Proj")).toBeUndefined();
  });

  it("codex: 탭이 없으면 none으로 알려 aith-codex가 직접 실행하게", async () => {
    const a = acks();
    expect(await handle({ id: "1", kind: "codex", cwd: "C:\\none", text: "x" }, a.ack)).toBeNull();
    expect(a.got).toEqual(["none:no-tab"]);
  });

  it("codex: 탭이 있으면 그 탭으로 보내고 결과를 돌려준다, 바쁘면 안내", async () => {
    let busy = false;
    const off = registerTab("t2", { kind: "codex", cwd: "C:\\P", running: () => busy, last: () => "", send: async (t) => `받음:${t}` });
    const a = acks();
    expect(await handle({ id: "2", kind: "codex", cwd: "C:\\P", text: " 고쳐 " }, a.ack)).toBe("받음:고쳐");
    expect(a.got).toEqual(["ok"]);
    busy = true;
    expect(await handle({ id: "3", kind: "codex", cwd: "C:\\P", text: "x" }, acks().ack)).toMatch(/작업 중/);
    off();
  });

  it("status: 바로 요약을 돌려준다", async () => {
    const a = acks();
    const out = await handle({ id: "4", kind: "status" }, a.ack);
    expect(a.got).toEqual(["ok"]);
    expect(out).toMatch(/^\[허브 상태\]/);
    expect(statusText(new Date(2026, 9, 21, 9, 5))).toMatch(/10\/21 09:05/);
  });

  it("이번 작업에서 바뀐 파일만 붙인다", () => {
    const files = [
      { kind: "edit", label: "a.ts", touchedAt: 10 },
      { kind: "read", label: "b.ts", touchedAt: 20 },
      { kind: "edit", label: "old.ts", touchedAt: 1 },
    ];
    expect(changedSince(files, 5)).toBe("\n\n[바뀐 파일]\n- a.ts");
    expect(changedSince(files, 100)).toBe("");
  });
});

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startRemoteBus } from "./remoteBus.svelte";
describe("원격 요청 받기 시작", () => {
  it("rc-request를 듣기 시작한 뒤에야 허브에 준비됐다고 알린다(쌓인 요청이 듣기 전에 지워지지 않게)", async () => {
    const order: string[] = [];
    vi.mocked(listen).mockImplementation(async () => {
      order.push("listen");
      return () => {};
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return undefined;
    });
    await startRemoteBus();
    expect(order).toEqual(["listen", "rc_ready"]);
  });
});

import { settings } from "./settings.svelte";
describe("팀 실험 기능이 꺼져 있을 때 원격 @pair", () => {
  it("새 팀 탭을 만들지 않고 안내한다", async () => {
    settings.experimentalTeam = false;
    const out = await handle({ id: "p1", kind: "pair", cwd: "C:\NoTeam", text: "해 줘" }, acks().ack);
    expect(out).toBe("팀 기능(실험 기능)이 꺼져 있어요. 설정 → 실험 기능에서 켤 수 있어요.");
    settings.experimentalTeam = true;
  });
});
