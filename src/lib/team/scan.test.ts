// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { it, expect } from "vitest";
import { scanDirs } from "./scan";

it("세 단계까지, 숨김·무거운 폴더는 건너뛴다", async () => {
  const tree: Record<string, { name: string; dir: boolean }[]> = {
    "C:/p": [{ name: "web", dir: true }, { name: "node_modules", dir: true }, { name: ".git", dir: true }, { name: "a.txt", dir: false }],
    "C:/p/web": [{ name: "src", dir: true }],
    "C:/p/web/src": [{ name: "login", dir: true }],
    "C:/p/web/src/login": [{ name: "deep", dir: true }],
  };
  const read = async (p: string) => tree[p.replaceAll("\\", "/")] ?? [];
  expect(await scanDirs("C:/p", read)).toEqual(["web", "web/src", "web/src/login"]);
});
