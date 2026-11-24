// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 지시 첨부 글: 이미지 경로는 "[이미지: 경로]"(에이전트가 열어서 보게), 그 외 파일은 따옴표로 감싼 경로.

const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const isImagePath = (p: string) => IMG.test(p);

export function attachText(paths: string[]): string {
  return paths.map((p) => (isImagePath(p) ? `[이미지: ${p}]` : `"${p}"`)).join(" ");
}

/** 지금 입력 뒤에 한 칸 띄우고 붙인다 */
export function insertText(cur: string, add: string): string {
  if (!add) return cur;
  const base = cur.replace(/\s+$/, "");
  return base ? `${base} ${add} ` : `${add} `;
}
