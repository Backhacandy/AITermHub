// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 지난 대화(기록 파일)의 사용자 메시지를 화면에 보일 글로: 앱이 붙인 안내문은 빼고, 시스템이 넣은 메시지는 숨긴다.

/** Claude Code가 사용자 차례로 기록하는 내부 메시지(작업 알림·리마인더·로컬 명령 출력 등) */
const SYSTEM = /^\s*<(task-notification|system-reminder|local-command-[\w-]+|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)>/;

/** 보일 글. 숨길 메시지면 null */
export function userText(text: string): string | null {
  if (SYSTEM.test(text) || text.startsWith("Caveat: The messages below were generated")) return null;
  // 협업 탭이 붙인 역할 안내 → [사용자 지시] 부분만
  if (/^\[(2인|팀) 협업/.test(text)) {
    const mark = "[사용자 지시]\n";
    const i = text.indexOf(mark);
    if (i >= 0) {
      let body = text.slice(i + mark.length);
      const j = body.search(/\n\n(\[내 몫\]|끝나면 답변 맨 끝에 "### 인계"|\(끝에 "### 인계")/);
      if (j >= 0) body = body.slice(0, j);
      return body.trim();
    }
  }
  return text;
}
