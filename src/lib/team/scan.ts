// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 몇 단계 안쪽 폴더 목록(무거운 폴더는 건너뜀) — 담당 영역 자동 감지·목적 제안에 쓴다.

import { invoke } from "@tauri-apps/api/core";

export type ReadDir = (path: string) => Promise<{ name: string; dir: boolean }[]>;

const SKIP = /^(node_modules|build|dist|out|outputs|target|bin|obj|gradle|library|temp|logs|vendor|venv|__pycache__)$/i;

export async function scanDirs(dir: string, readDir: ReadDir, depthMax = 3, limit = 400): Promise<string[]> {
  const dirs: string[] = [];
  let level = [""];
  for (let depth = 0; depth < depthMax && level.length && dirs.length < limit; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      const path = rel ? `${dir}\\${rel.replaceAll("/", "\\")}` : dir;
      const list = await readDir(path).catch(() => []);
      for (const e of list) {
        if (!e.dir || e.name.startsWith(".") || SKIP.test(e.name)) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        dirs.push(p);
        next.push(p);
      }
    }
    level = next;
  }
  return dirs;
}

/** 앱에서 쓰는 폴더 읽기(Tauri fs_read_dir) */
export const readDir: ReadDir = (path) => invoke<{ name: string; dir: boolean }[]>("fs_read_dir", { path });
