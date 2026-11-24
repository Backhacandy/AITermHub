// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 처음 켠 사람 안내: Claude Code·Codex CLI가 설치돼 있는지 확인한다(로그인은 첫 세션에서 CLI가 직접 안내).
export type CliState = "missing" | "installed";
export interface CliStatus {
  claude: CliState;
  codex: CliState;
}

/** which: ["claude","codex"]의 실행 파일 경로(없으면 null) — Tauri 명령 which_cli */
export async function detect(which: (names: string[]) => Promise<(string | null)[]>): Promise<CliStatus> {
  const r = await which(["claude", "codex"]).catch(() => [null, null]);
  return { claude: r[0] ? "installed" : "missing", codex: r[1] ? "installed" : "missing" };
}

export function nextStep(s: CliStatus): "install" | "ready" {
  return s.claude === "installed" || s.codex === "installed" ? "ready" : "install";
}

// Claude Code는 공식 권장이 네이티브 설치(PowerShell). npm 설치(npm i -g @anthropic-ai/claude-code)도 된다
export const INSTALL_CMD = { claude: "irm https://claude.ai/install.ps1 | iex", codex: "npm install -g @openai/codex" };
export const DOCS = { claude: "https://docs.claude.com/en/docs/claude-code/setup", codex: "https://github.com/openai/codex" };

/** CLI가 없어도 넘어갈 수 있다(터미널 탭·다른 에이전트만 쓰는 사람, 나중에 설치할 사람) */
export const canContinue = (_s: CliStatus) => true;

/** 방금 설치했는데 안 보일 때: 앱은 시작할 때의 PATH를 쓰므로 다시 켜야 보일 수 있다 */
export function restartHint(s: CliStatus): string {
  return nextStep(s) === "install" ? "방금 설치했는데도 '없음'이면 AITermHub를 껐다 다시 켜 주세요(설치 경로를 앱을 켤 때 읽어요)." : "";
}
