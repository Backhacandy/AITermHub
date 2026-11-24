// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 웹 미리보기 도우미: 주소 정리, 이 PC 주소만 허용(보안 정책과 같게), 화면 너비.

export type Width = "mobile" | "tablet" | "full";
export const WIDTHS: Record<Width, { label: string; px: number | null }> = {
  mobile: { label: "모바일", px: 390 },
  tablet: { label: "태블릿", px: 820 },
  full: { label: "전체", px: null },
};

/** "5173", "localhost:3000", "localhost:3000/a" → http://… */
export function normalizeUrl(s: string): string {
  const t = s.trim();
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  return `http://${t}`;
}

/** 허브 안에서 열 수 있는 주소: http(s)://localhost·127.0.0.1 */
export function isLocalUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return (x.protocol === "http:" || x.protocol === "https:") && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}
