// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 폰(원격 Claude 세션) ↔ 허브 통로. 원격 세션의 aith-hub / aith-codex가 요청 파일을 쓰면
// 백엔드가 "rc-request"로 알려 주고, 여기서 처리해 rc_ack(받았음/못 받음) → rc_reply(결과)로 답한다.
//  - status: 허브 탭·한도·폰 연결 상태 요약
//  - pair:   그 폴더의 협업 탭에 지시(없으면 열어서) → 두 에이전트가 끝나면 답변
//  - codex:  그 폴더의 Codex 탭이 열려 있으면 그 탭으로 보낸다(없으면 aith-codex가 직접 실행)
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tabs, active, addPair } from "$lib/sessions.svelte";
import { acc } from "$lib/accounts.svelte";
import { rem, sameDir, STATUS_LABEL } from "$lib/remote.svelte";
import { settings } from "$lib/settings.svelte";
import { experimentalOn } from "$lib/experimental";

export type HandleKind = "claude" | "codex" | "pair";

export interface TabHandle {
  kind: HandleKind;
  cwd: string;
  running(): boolean;
  /** 마지막 답변(상태 요약용) */
  last(): string;
  /** 폰에서 보낸 지시를 처리하고, 끝나면 결과 글을 돌려준다(바쁘면 Error) */
  send?(text: string): Promise<string>;
  /** AI 회사 등: 한 줄 요약 */
  summary?(): string;
}

// 반응형이 아닌 Map: $state에 넣으면 저장 값이 프록시가 되어 해제 때 `저장값 === h` 비교가 늘 거짓이었다
// → 닫은 탭의 핸들이 남아 원격 지시가 죽은 탭으로 가서 끝없이 기다렸다(11/24). 해제는 등록 때 만든 번호로 비교한다.
const handles = new Map<string, { token: number; h: TabHandle }>();
let nextToken = 0;
let wrapForTest: ((h: TabHandle) => TabHandle) | null = null;
/** 테스트 전용: 저장할 때 값을 다른 객체로 바꿔 넣는다(프록시 흉내) */
export function __wrapStoreForTest(f: ((h: TabHandle) => TabHandle) | null) {
  wrapForTest = f;
}

/** 그 id의 탭이 지금 열려 있는지(닫힌 탭의 핸들을 쓰지 않게 한 번 더 거른다) */
let tabOpen: (id: string) => boolean = (id) => tabs.some((t) => t.id === id);
export function setTabCheck(f: (id: string) => boolean) {
  tabOpen = f;
}

/** 화면이 뜰 때 등록, 반환 함수로 해제 */
export function registerTab(id: string, h: TabHandle): () => void {
  const token = ++nextToken;
  handles.set(id, { token, h: wrapForTest ? wrapForTest(h) : h });
  return () => {
    if (handles.get(id)?.token === token) handles.delete(id);
  };
}

export function findHandle(kind: HandleKind, cwd: string): [string, TabHandle] | undefined {
  for (const [id, { h }] of handles) if (h.kind === kind && sameDir(h.cwd, cwd) && tabOpen(id)) return [id, h];
  return undefined;
}

async function waitHandle(kind: HandleKind, cwd: string, ms: number): Promise<[string, TabHandle] | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = findHandle(kind, cwd);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const pct = (v: number | undefined) => (typeof v === "number" ? `${Math.round(v)}%` : "?");

/** 허브 상태 요약 글(폰 @상태) */
export function statusText(now = new Date()): string {
  const out: string[] = [];
  const hm = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  out.push(`[허브 상태] ${hm}`);
  const shown = tabs.filter((t) => t.kind !== "term" || t.cwd);
  if (shown.length) {
    out.push("탭");
    for (const t of shown) {
      const h = handles.get(t.id)?.h;
      const busy = h ? h.running() : !!acc.busy[t.id];
      if (h?.summary) {
        out.push(`- ${h.summary()}`);
        continue;
      }
      const last = h?.last() ? ` — 마지막: ${clip(h.last(), 70)}` : "";
      // 예전 탭 제목에는 폴더가 없을 수 있어 붙인다(탭 막대와 같게)
      const dir = t.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      const name = dir && !t.title.includes(" · ") ? `${t.title} · ${dir}` : t.title;
      out.push(`- ${busy ? "작업 중" : "대기"} · ${name}${last}`);
    }
  } else out.push("열린 탭 없음");
  const lim = acc.list.filter((a) => a.enabled && a.loggedIn);
  if (lim.length) {
    out.push("한도(사용률)");
    for (const a of lim) {
      out.push(`- ${a.cli === "claude" ? "Claude" : "Codex"} ${a.email ?? a.id}${a.active ? " (사용 중)" : ""}: 5시간 ${pct(a.limits?.five?.pct)} · 주간 ${pct(a.limits?.week?.pct)}`);
    }
  }
  const on = rem.list.filter((r) => r.status !== "stopped");
  if (on.length) out.push(`폰 연결: ${on.map((r) => `${r.name}(${STATUS_LABEL[r.status]})`).join(", ")}`);
  return out.join("\n");
}

interface Req {
  id: string;
  kind: string;
  cwd?: string;
  text?: string;
}

const busyMsg = (what: string) => `허브의 ${what} 탭이 다른 작업 중이에요. 끝난 뒤 다시 보내 주세요.`;

/** 요청 처리: 받을 수 있으면 "ok", 아니면 "none:이유"를 먼저 알리고, 결과 글을 돌려준다 */
export async function handle(req: Req, ack: (a: string) => Promise<void>): Promise<string | null> {
  const cwd = req.cwd ?? "";
  const text = (req.text ?? "").trim();
  if (req.kind === "status") {
    await ack("ok");
    return statusText();
  }
  if (req.kind === "codex") {
    const f = findHandle("codex", cwd);
    if (!f?.[1].send) {
      await ack("none:no-tab");
      return null;
    }
    await ack("ok");
    if (f[1].running()) return busyMsg("Codex");
    return f[1].send(text).catch((e) => `오류: ${e instanceof Error ? e.message : e}`);
  }
  if (req.kind === "pair") {
    await ack("ok");
    if (!cwd || !text) return "폴더나 지시가 비어 있어요.";
    let f = findHandle("pair", cwd);
    if (!f && !experimentalOn(settings)) return "팀 기능(실험 기능)이 꺼져 있어요. 설정 → 실험 기능에서 켤 수 있어요.";
    if (!f) {
      addPair(cwd);
      f = await waitHandle("pair", cwd, 90_000);
      if (!f) return "팀 탭을 열었지만 준비되지 않았어요. PC에서 확인해 주세요.";
    }
    if (f[1].running()) return busyMsg("팀");
    return f[1].send!(text).catch((e) => `오류: ${e instanceof Error ? e.message : e}`);
  }
  await ack(`none:unknown-kind`);
  return null;
}

let started = false;
/** 원격 요청 듣기 시작 → 다 걸린 뒤 허브에 준비됐다고 알린다(그 전엔 허브가 쌓인 요청을 읽지 않음) */
export async function startRemoteBus() {
  if (started) return;
  started = true;
  await listen<Req>("rc-request", async (e) => {
    const req = e.payload;
    const ack = (a: string) => invoke<void>("rc_ack", { id: req.id, text: a }).catch(() => {});
    try {
      const out = await handle(req, ack);
      if (out !== null) await invoke("rc_reply", { id: req.id, text: out });
    } catch (err) {
      await invoke("rc_reply", { id: req.id, text: `오류: ${err}` }).catch(() => {});
    }
  });
  await invoke("rc_ready").catch(() => {});
}

// ---- 탭 입력창 채우기(GitHub 패널의 "에이전트에게 리뷰" 등) — 화면이 읽어서 입력창에 넣고 지운다 ----
export const fills = $state<Record<string, string>>({});

export function fillInput(tabId: string, text: string) {
  fills[tabId] = fills[tabId] ? `${fills[tabId]}\n\n${text}` : text;
  active.id = tabId;
}

/** 입력창 글 합치기 */
export const joinInput = (cur: string, add: string) => (cur.trim() ? `${cur.trim()}\n\n${add}` : add);

/** 이 폴더의 Claude·Codex·협업 탭(지금 보고 있는 탭 우선, 없으면 null) */
export function agentTabFor(cwd: string): string | null {
  const ok = (t: { kind: string; cwd?: string }) => (t.kind === "claude" || t.kind === "codex" || t.kind === "pair") && !!t.cwd && sameDir(t.cwd, cwd);
  const cur = tabs.find((t) => t.id === active.id);
  if (cur && ok(cur)) return cur.id;
  return tabs.find(ok)?.id ?? null;
}

/** 이번 턴에 바뀐 파일 목록(결과 글 끝에 붙임) */
export function changedSince(files: { kind: string; label: string; touchedAt: number }[], since: number): string {
  const ch = files.filter((f) => f.kind === "edit" && f.touchedAt >= since).map((f) => `- ${f.label}`);
  return ch.length ? `\n\n[바뀐 파일]\n${ch.join("\n")}` : "";
}
