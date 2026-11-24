// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// build: aith-bk26-68a3b8a0b4ae
// 모든 소스 파일 맨 위에 저작권 머리글을 넣는다. --check면 고치지 않고 빠진 파일만 알려 준다(빠진 게 있으면 종료 코드 1).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const NOTICE = "Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.";
const check = process.argv.includes("--check");
const STYLE = { ".ts": "//", ".js": "//", ".mjs": "//", ".rs": "//", ".ps1": "#", ".sh": "#", ".svelte": "html" };
const DIRS = /^(src|src-tauri\/src|src-tauri\/resources|scripts)\//;
const ROOT_FILES = ["vite.config.js", "svelte.config.js", "vitest.config.ts", "src-tauri/build.rs"];

const extOf = (f) => (f.match(/\.[^./]+$/) ?? [""])[0];
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => (DIRS.test(f) || ROOT_FILES.includes(f)) && STYLE[extOf(f)])
  .concat(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => (DIRS.test(f) || ROOT_FILES.includes(f)) && STYLE[extOf(f)]))
  .filter((f, i, a) => f && a.indexOf(f) === i);
// 확장자 없는 sh 훅(aith-prompt-hook)
for (const f of execFileSync("git", ["ls-files", "src-tauri/resources"], { encoding: "utf8" }).split("\n")) if (f && !extOf(f)) files.push(f);

let missing = 0;
for (const f of files) {
  let raw = readFileSync(f, "utf8");
  if (raw.includes(NOTICE)) continue;
  missing++;
  if (check) {
    console.log(`머리글 없음: ${f}`);
    continue;
  }
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  if (bom) raw = raw.slice(1);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const style = STYLE[extOf(f)] ?? "#";
  const line = style === "html" ? `<!-- ${NOTICE} -->` : `${style} ${NOTICE}`;
  let out;
  if (raw.startsWith("#!")) {
    const i = raw.indexOf("\n") + 1;
    out = raw.slice(0, i) + line + eol + raw.slice(i);
  } else if (raw.startsWith("#![") || raw.startsWith("//!")) {
    out = line + eol + raw; // Rust 내부 속성·모듈 문서 위에 일반 주석은 괜찮다
  } else {
    out = line + eol + raw;
  }
  writeFileSync(f, bom + out);
}
console.log(check ? (missing ? `\n머리글 없는 파일 ${missing}개` : "모든 파일에 머리글이 있어요") : `머리글 넣음 ${missing}개`);
process.exit(check && missing ? 1 : 0);
