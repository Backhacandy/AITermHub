// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 처음 켠 사람 안내: PC에 있는 AI CLI(Claude Code·Codex·Gemini 등)를 찾는다.
// 로그인 여부는 각 CLI의 상태 명령에게 묻는다(Tauri cli_login) — 로그인 정보 파일은 읽지 않는다.
import { CLI_AGENTS } from "./agents/registry";

export type CliState = "missing" | "installed";
export interface CliStatus {
  claude: CliState;
  codex: CliState;
  /** 설치된 다른 AI(registry id) */
  others: string[];
}

/** which_cli에 넘길 이름: Claude·Codex 다음에 다른 AI들 */
export const CHECK_NAMES = ["claude", "codex", ...CLI_AGENTS.map((a) => a.cmd)];

/** which: 이름마다 실행 파일 경로(없으면 null) — Tauri 명령 which_cli */
export async function detect(which: (names: string[]) => Promise<(string | null)[]>): Promise<CliStatus> {
  const r = await which(CHECK_NAMES).catch(() => [] as (string | null)[]);
  return {
    claude: r[0] ? "installed" : "missing",
    codex: r[1] ? "installed" : "missing",
    others: CLI_AGENTS.filter((_, i) => r[i + 2]).map((a) => a.id),
  };
}

const anyInstalled = (s: CliStatus) => s.claude === "installed" || s.codex === "installed" || s.others.length > 0;

export function nextStep(s: CliStatus): "install" | "ready" {
  return anyInstalled(s) ? "ready" : "install";
}

/** 로그인 표시. true 로그인됨 · false 안 됨 · null 확인 못 함(상태 명령 없음) · undefined 확인 중 */
export function loginLabel(login: boolean | null | undefined): string {
  if (login === true) return "로그인됨";
  if (login === false) return "로그인 필요 — 첫 세션을 열면 안내해요";
  if (login === undefined) return "확인 중…";
  return "설치됨";
}

// Claude Code는 공식 권장이 네이티브 설치(PowerShell). npm 설치(npm i -g @anthropic-ai/claude-code)도 된다
export const INSTALL_CMD = { claude: "irm https://claude.ai/install.ps1 | iex", codex: "npm install -g @openai/codex" };
export const DOCS = { claude: "https://docs.claude.com/en/docs/claude-code/setup", codex: "https://github.com/openai/codex" };

/** CLI가 없어도 넘어갈 수 있다(터미널 탭만 쓰는 사람, 나중에 설치할 사람) */
export const canContinue = (_s: CliStatus) => true;

/** 방금 설치했는데 안 보일 때: 앱은 시작할 때의 PATH를 쓰므로 다시 켜야 보일 수 있다 */
export function restartHint(s: CliStatus): string {
  return nextStep(s) === "install" ? "방금 설치했는데도 '없음'이면 AITermHub를 껐다 다시 켜 주세요(설치 경로를 앱을 켤 때 읽어요)." : "";
}
