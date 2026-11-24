// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// GitHub 잔디 자동 올리기: 설정에 적어 둔 폴더(GitHub 저장소와 연결된 git 저장소)를 30분마다 살펴,
// 마지막 자동 커밋에서 3시간이 지났고 바뀐 게 있으면 커밋해 올린다(Rust grass_commit). 하루에 몇 번 정도만 쌓이게.
import { invoke } from "@tauri-apps/api/core";

/** 같은 폴더를 다시 자동 커밋하기까지 최소 간격 */
export const GRASS_GAP_MS = 3 * 60 * 60_000;
const CHECK_MS = 30 * 60_000;
const LAST_KEY = "aith.grass.last";

/** 설정에 폴더 목록이 없으면(예전 버전) 지금까지 잔디를 올린 폴더 기록에서 가져온다 — 코드에 개인 폴더를 두지 않는다 */
export function migrateGrassDirs(dirs: string[] | undefined, last: Record<string, number>): string[] {
  return dirs ?? Object.keys(last).sort();
}
/** 지금까지 잔디를 올린 폴더 기록 */
export const grassHistory = (): Record<string, number> => loadLast();

export interface GrassResult {
  status: "committed" | "clean" | "error";
  message: string;
  skipped: string[];
}

/** 이번에 살펴볼 차례인 폴더 */
export function dueDirs(dirs: string[], last: Record<string, number>, now: number): string[] {
  return dirs.filter((d) => now - (last[d] ?? 0) >= GRASS_GAP_MS);
}

/** 설정 창의 폴더 목록 글 → 폴더들 */
export function parseDirs(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const d = line.trim().replace(/[\\/]+$/, "");
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

function loadLast(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveLast(v: Record<string, number>) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    // 저장 실패는 무시(다음에 다시 살핀다)
  }
}

/** 지금 한 번: 차례인 폴더(force면 전부)를 커밋해 올리고 결과를 돌려준다 */
/** email: 커밋 작성자(GitHub noreply 주소) */
export async function grassNow(dirs: string[], email: string, force = false): Promise<{ dir: string; result: GrassResult }[]> {
  const last = loadLast();
  const now = Date.now();
  const out: { dir: string; result: GrassResult }[] = [];
  for (const dir of force ? dirs : dueDirs(dirs, last, now)) {
    const result = await invoke<GrassResult>("grass_commit", { dir, email }).catch((e) => ({ status: "error", message: String(e), skipped: [] }) as GrassResult);
    // 바뀐 게 없었으면 다음 점검 때 다시 본다(커밋했을 때만 3시간 쉰다)
    if (result.status === "committed") last[dir] = now;
    out.push({ dir, result });
  }
  saveLast(last);
  return out;
}

let timer: ReturnType<typeof setInterval> | undefined;
/** 앱 시작 때 한 번. on·dirs는 그때그때 설정에서 읽는다 */
export function startGrass(get: () => { on: boolean; dirs: string[]; email: () => Promise<string> }) {
  if (timer) return;
  const tick = async () => {
    const { on, dirs, email } = get();
    if (!on || !dirs.length) return;
    const e = await email().catch(() => "");
    if (e) void grassNow(dirs, e);
  };
  setTimeout(tick, 2 * 60_000); // 켜고 2분 뒤 한 번
  timer = setInterval(tick, CHECK_MS);
}

/** 커밋 작성자 이메일(설정에 있으면 그것, 없으면 gh 계정에서 만들어 저장) */
export async function grassEmail(s: { grassEmail?: string }, save: () => void): Promise<string> {
  if (s.grassEmail) return s.grassEmail;
  const e = await invoke<string>("gh_noreply");
  s.grassEmail = e;
  save();
  return e;
}
