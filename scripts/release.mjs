// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 배포판 릴리스: 이미 빌드한 NSIS 설치 파일·서명으로 업데이트 정보(latest.json)를 만들고 GitHub 릴리스로 올린다.
// 먼저: TAURI_SIGNING_PRIVATE_KEY(서명 키)를 설정하고 `npm run tauri:release`.
// 사용: node scripts/release.mjs <버전> <노트 파일> [--dry]
//  - 베타도 prerelease가 아닌 일반 릴리스로 올린다(업데이트 주소 releases/latest는 prerelease를 건너뛴다).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const [version, notesFile] = process.argv.slice(2);
const dry = process.argv.includes("--dry");
if (!version || !notesFile) {
  console.error("사용: node scripts/release.mjs <버전> <노트 파일> [--dry]");
  process.exit(2);
}
const REPO = "Backhacandy/AITermHub";
const dir = join("src-tauri", "target", "release", "bundle", "nsis");
const exe = `AITermHub_${version}_x64-setup.exe`;
const exePath = join(dir, exe);
const sigPath = `${exePath}.sig`;
for (const f of [exePath, sigPath, notesFile]) if (!existsSync(f)) throw new Error(`없음: ${f}`);

const notes = readFileSync(notesFile, "utf8").trim();
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${exe}`,
    },
  },
};
const latestPath = join(dir, "latest.json");
writeFileSync(latestPath, JSON.stringify(latest, null, 2));
console.log(`latest.json 만듦: ${latestPath}`);
if (dry) {
  console.log("--dry: 올리지 않음");
  process.exit(0);
}
execFileSync("gh", ["release", "create", `v${version}`, "--repo", REPO, "--title", `AITermHub ${version}`, "--notes-file", notesFile, "--latest", exePath, sigPath, latestPath], { stdio: "inherit" });
