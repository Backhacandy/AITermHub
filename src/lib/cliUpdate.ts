// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Claude Code·Codex CLI 자동 업데이트: 하루 한 번, 일하는 에이전트가 없을 때만 올린다(이미 떠 있는 세션은 그대로, 새로 시작하는 세션부터 새 버전).
import { invoke } from "@tauri-apps/api/core";

export interface CliUpdate {
  cli: "claude" | "codex" | string;
  before: string;
  after: string;
  ok: boolean;
  message: string;
}

const DAY = 24 * 3600_000;
const LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

/** 올릴 때인지: 켜져 있고(설정이 없으면 켜짐) 마지막으로 올린 지 하루가 지났고 일하는 에이전트가 없을 때 */
export function cliUpdateDue(on: boolean | undefined, lastAt: number | undefined, now: number, busy: boolean): boolean {
  if (on === false || busy) return false;
  return lastAt === undefined || now - lastAt >= DAY;
}

/** 결과 한 줄과 알릴 만한지(버전이 바뀌었거나 실패) */
export function summarize(list: CliUpdate[]): { text: string; notable: boolean } {
  const text = list.map((u) => `${LABEL[u.cli] ?? u.cli} ${u.ok ? u.message : `실패: ${u.message}`}`).join(" · ");
  return { text, notable: list.some((u) => !u.ok || (u.before && u.after && u.before !== u.after)) };
}

/** 지금 둘 다 올린다 */
export async function updateClis(): Promise<CliUpdate[]> {
  const out: CliUpdate[] = [];
  for (const cli of ["claude", "codex"]) {
    out.push(await invoke<CliUpdate>("cli_update", { cli }).catch((e) => ({ cli, before: "", after: "", ok: false, message: String(e) })));
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | undefined;
/** 30분마다 확인해 때가 되면 올린다. done: 결과(한 줄·알릴 만한지)와 시각을 저장·알림 */
export function startCliUpdate(get: () => { on?: boolean; lastAt?: number; busy: boolean }, done: (r: { text: string; notable: boolean }, at: number) => void) {
  if (timer) return;
  let running = false;
  const tick = async () => {
    const s = get();
    if (running || !cliUpdateDue(s.on, s.lastAt, Date.now(), s.busy)) return;
    running = true;
    try {
      done(summarize(await updateClis()), Date.now());
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 10 * 60_000);
  timer = setInterval(tick, 30 * 60_000);
}
