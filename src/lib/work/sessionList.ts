// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 대화 고르기 목록 표시: 이름(자동 제목 → 첫 질문)과 마지막으로 쓴 때.
import { userText } from "./userText";

export interface SessionInfo {
  id: string;
  /** 마지막 수정(초) */
  mtime: number;
  size: number;
  title: string | null;
  first: string | null;
  last: string;
}

export function sessionLabel(s: { title: string | null; first: string | null }): string {
  if (s.title) return s.title;
  const f = s.first ? userText(s.first) : null;
  return f?.trim() || "내용 없음";
}

export function sessionAgo(mtimeS: number, nowS = Date.now() / 1000): string {
  const m = Math.floor((nowS - mtimeS) / 60);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
