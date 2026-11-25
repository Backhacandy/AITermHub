// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 다른 CLI 에이전트(Gemini·Qwen·OpenCode·Copilot·Cursor·Aider): 설치돼 있으면 폴더에서 터미널 탭으로 연다.
// Claude·Codex처럼 작업 과정을 구조화해 보여주지는 않고(에이전트마다 출력 형식이 다름) 터미널 그대로 쓴다.

export interface CliAgent {
  id: string;
  name: string;
  /** 실행 명령(PATH에서 찾음) */
  cmd: string;
  /** 설정의 "에이전트 전체 권한"이 켜져 있을 때 붙이는 인자(확인 없이 실행) */
  fullArgs: string[];
  /** 설치 명령(PowerShell 탭에서 실행) */
  install: string;
  site: string;
  note?: string;
}

export const CLI_AGENTS: CliAgent[] = [
  { id: "gemini", name: "Gemini CLI", cmd: "gemini", fullArgs: ["--yolo"], install: "npm install -g @google/gemini-cli", site: "https://github.com/google-gemini/gemini-cli", note: "Google 계정 로그인 · 무료 한도 넉넉" },
  { id: "qwen", name: "Qwen Code", cmd: "qwen", fullArgs: ["--yolo"], install: "npm install -g @qwen-code/qwen-code", site: "https://github.com/QwenLM/qwen-code" },
  { id: "opencode", name: "OpenCode", cmd: "opencode", fullArgs: [], install: "npm install -g opencode-ai", site: "https://opencode.ai", note: "여러 모델 제공자를 골라 씀" },
  { id: "copilot", name: "GitHub Copilot CLI", cmd: "copilot", fullArgs: ["--allow-all-tools"], install: "npm install -g @github/copilot", site: "https://github.com/github/copilot-cli", note: "Copilot 구독 필요" },
  { id: "cursor", name: "Cursor CLI", cmd: "cursor-agent", fullArgs: [], install: "irm 'https://cursor.com/install?win32=true' | iex", site: "https://cursor.com/cli", note: "Cursor 구독 필요" },
  { id: "aider", name: "Aider", cmd: "aider", fullArgs: ["--yes-always"], install: "python -m pip install aider-install; aider-install", site: "https://aider.chat", note: "API 키로 여러 모델" },
];

export const agentById = (id: string | undefined) => CLI_AGENTS.find((a) => a.id === id);

/** AI 추가 목록·첫 실행 안내에 쓰는 전체 목록 한 줄 */
export interface AiEntry {
  id: string;
  name: string;
  cmd: string;
  install: string;
  site: string;
  note?: string;
  /** Claude·Codex: 작업 과정을 구조화해 보여 주는 전용 탭으로 연다 */
  structured?: boolean;
  /** 로그인 명령(터미널 탭에서 실행). 상태 명령으로 로그인 여부를 확인할 수 있는 AI만 */
  loginCmd?: string;
}

// Claude Code는 공식 권장이 네이티브 설치(PowerShell). npm 설치(npm i -g @anthropic-ai/claude-code)도 된다
export const MAIN_AIS: AiEntry[] = [
  { id: "claude", name: "Claude Code", cmd: "claude", install: "irm https://claude.ai/install.ps1 | iex", site: "https://docs.claude.com/en/docs/claude-code/setup", note: "진행 로그·변경 내용·계정 전환까지", structured: true, loginCmd: "claude" },
  { id: "codex", name: "Codex", cmd: "codex", install: "npm install -g @openai/codex", site: "https://github.com/openai/codex", note: "Node.js 필요 · 진행 로그·변경 내용까지", structured: true, loginCmd: "codex login" },
];

/** Claude·Codex가 맨 앞, 이어서 다른 AI 모두. 어느 하나가 필수는 아니다 */
export const ALL_AIS: AiEntry[] = [...MAIN_AIS, ...CLI_AGENTS];

/** cmd.exe로 띄울 인자 */
export function launchArgs(a: CliAgent, full: boolean): string[] {
  return ["/k", a.cmd, ...(full ? a.fullArgs : [])];
}
