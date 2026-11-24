// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 모바일 원격 제어: 프로젝트 폴더마다 `claude remote-control`을 띄워 폰 Claude 앱(Code 탭)·claude.ai/code에서 조종.
// 켠 폴더는 설정(remoteDirs)에 기억해 허브를 다시 켤 때 자동으로 다시 연결한다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { settings, saveSettings } from "$lib/settings.svelte";

export interface Remote {
  cwd: string;
  name: string;
  status: "starting" | "connected" | "error" | "stopped";
  url: string | null;
  error: string | null;
  pid: number;
}

export const rem = $state<{ list: Remote[]; busy: Record<string, boolean>; err: string }>({ list: [], busy: {}, err: "" });

const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
export const sameDir = (a: string, b: string) => norm(a) === norm(b);

export function remoteOf(cwd: string): Remote | undefined {
  return rem.list.find((r) => sameDir(r.cwd, cwd));
}

function upsert(r: Remote) {
  const i = rem.list.findIndex((x) => sameDir(x.cwd, r.cwd));
  if (i >= 0) rem.list[i] = r;
  else rem.list.push(r);
}

/** 켠 폴더 목록 갱신(같은 폴더는 하나만) — 순수 함수 */
export function withDir(list: string[], cwd: string, on: boolean): string[] {
  const rest = list.filter((d) => !sameDir(d, cwd));
  return on ? [...rest, cwd] : rest;
}

function remember(cwd: string, on: boolean) {
  const next = withDir(settings.remoteDirs ?? [], cwd, on);
  if (JSON.stringify(next) === JSON.stringify(settings.remoteDirs ?? [])) return;
  settings.remoteDirs = next;
  void saveSettings();
}

let listening: Promise<void> | null = null;
export function listenRemotes(): Promise<void> {
  listening ??= (async () => {
    await listen<Remote>("remote-status", (e) => upsert(e.payload));
    const l = await invoke<Remote[]>("remote_list").catch(() => []);
    l.forEach(upsert);
  })();
  return listening;
}

export async function startRemote(cwd: string) {
  rem.err = "";
  rem.busy[cwd] = true;
  try {
    upsert(await invoke<Remote>("remote_start", { cwd, full: settings.fullAccess }));
    remember(cwd, true);
  } catch (e) {
    rem.err = String(e);
  } finally {
    rem.busy[cwd] = false;
  }
}

export async function stopRemote(cwd: string) {
  rem.busy[cwd] = true;
  await invoke("remote_stop", { cwd }).catch(() => {});
  const r = remoteOf(cwd);
  if (r) r.status = "stopped";
  remember(cwd, false);
  rem.busy[cwd] = false;
}

/** 허브 시작 시: 지난번에 켜 둔 폴더를 다시 연결 */
export async function restoreRemotes() {
  await listenRemotes();
  for (const d of settings.remoteDirs ?? []) {
    const r = remoteOf(d);
    if (!r || r.status === "stopped") await startRemote(d);
  }
}

export const STATUS_LABEL: Record<Remote["status"], string> = {
  starting: "연결 중…",
  connected: "연결됨",
  error: "오류",
  stopped: "꺼짐",
};
