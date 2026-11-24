// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 오른쪽 "만진 파일" 목록 로직: 파일 1개 = 항목 1개, 최근에 만진 것이 맨 위.
import type { FileEntry, FileKind, ReadResult } from "./types";

export const MAX_FILES = 500;
const RANK: Record<FileKind, number> = { read: 0, run: 1, edit: 2 };

export type FileInit = Pick<FileEntry, "key" | "kind" | "label"> & Partial<FileEntry>;

/** key로 찾거나 만들고, 맨 앞으로 옮긴 뒤 update를 적용한다. 반환값은 배열 안의 항목. */
export function touchFile(
  list: FileEntry[],
  init: FileInit,
  now: number,
  update?: (f: FileEntry) => void
): FileEntry {
  const idx = list.findIndex((f) => f.key === init.key);
  if (idx >= 0) {
    const [old] = list.splice(idx, 1);
    if (RANK[init.kind] > RANK[old.kind]) old.kind = init.kind;
    if (init.path && !old.path) old.path = init.path;
    list.unshift(old);
  } else {
    list.unshift({
      status: "running",
      origin: undefined,
      prev: undefined,
      content: "",
      writing: false,
      added: 0,
      removed: 0,
      ...init,
      touchedAt: now,
    });
  }
  const e = list[0];
  e.touchedAt = now;
  update?.(e);
  if (list.length > MAX_FILES) list.length = MAX_FILES;
  return e;
}

export function relTime(t: number, now: number): string {
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "방금";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간`;
  return `${Math.floor(h / 24)}일`;
}

/** 경로 비교용 키(Windows: 대소문자·구분자 무시). */
export function fileKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** cwd 안이면 상대경로(`/` 구분), 밖이면 원래 경로(`/` 구분). */
export function relLabel(cwd: string, path: string): string {
  const base = fileKey(cwd) + "/";
  const p = path.replace(/\\/g, "/");
  return p.toLowerCase().startsWith(base) ? p.slice(base.length) : p;
}

export function absPath(cwd: string, p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/")) return p;
  return `${cwd.replace(/[\\/]+$/, "")}\\${p.replace(/\//g, "\\")}`;
}

export function diffMeta(f: Pick<FileEntry, "added" | "removed" | "binary">): string {
  return f.binary ? "바이너리" : `+${f.added} −${f.removed}`;
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 읽기 결과에서 비교·표시에 쓸 텍스트(바이너리·실패면 null) */
export function textOf(r: ReadResult | null | undefined): string | null {
  return r && !r.binary ? r.text : null;
}

/** 로그에 보일 짧은 명령: PowerShell -Command 감싸기를 벗기고 첫 줄만. */
export function shortCommand(cmd: string, max = 120): string {
  let c = cmd.trim();
  const m = c.match(/^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i);
  if (m) {
    c = m[1].trim();
    if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) c = c.slice(1, -1);
  }
  const lines = c.split(/\r?\n/);
  const one = lines.length > 1 ? `${lines[0]} …` : lines[0];
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
