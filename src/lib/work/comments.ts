// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 코드 리뷰 코멘트: 오른쪽 코드 뷰에서 줄에 남긴 메모를 모아 "이대로 고쳐" 지시 글로 만든다.

export interface LineComment {
  id: number;
  /** 파일 표시 이름(상대 경로) */
  file: string;
  /** 1부터 */
  line: number;
  /** 그 줄의 코드(지시에 함께 넣어 위치가 바뀌어도 찾을 수 있게) */
  code: string;
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function composeReview(list: LineComment[]): string {
  const items = list
    .filter((c) => c.text.trim())
    .slice()
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
    .map((c) => {
      const code = c.code.trim();
      return `- ${c.file}:${c.line}${code ? ` \`${clip(code, 80).replace(/`/g, "'")}\`` : ""} → ${c.text.trim()}`;
    });
  if (!items.length) return "";
  return `아래 코드 리뷰 코멘트대로 고쳐줘.\n${items.join("\n")}`;
}
