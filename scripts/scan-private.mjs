// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 공개 전 검사: 저장소가 추적하는 파일에서 비밀 키·개인 이메일·실명·사용자 개인 프로젝트 이름·개인 경로를 찾는다.
// 사용: node scripts/scan-private.mjs [폴더]  → 찾은 것이 있으면 목록을 출력하고 종료 코드 1
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.argv[2] ?? process.cwd();
// 공개하지 않는 내부 문서·이 검사 스크립트 자신은 건너뛴다
const SKIP = [/^docs\/superpowers\//, /^docs\/marketing\//, /^promo\//, /^scripts\/scan-private\.mjs$/, /^LICENSE$/, /package-lock\.json$/, /Cargo\.lock$/, /\.(png|jpg|jpeg|ico|icns|gif|webp|mp4|woff2?|ttf)$/i];
const RULES = [
  ["비밀 키", /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,})/],
  ["개인 키 파일", /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["이메일", /(?<![A-Za-z0-9._%+-])(?!git@)[A-Za-z0-9._%+-]+@(?!\d+x\.)(?!users\.noreply\.github\.com|example\.(com|org)|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["개인 경로", /C:\\\\?Users\\\\?[A-Za-z0-9_]+|\/c\/Users\/[A-Za-z0-9_]+/i],
];

// 개인 단어(실명·아이디·개인 프로젝트 이름)는 저장소에 두지 않는다 — 저장소 밖 파일에서 읽는다(한 줄에 하나)
const WORDS = process.env.AITH_SCAN_WORDS ?? join(homedir(), "aitermhub-private", "scan-words.txt");
if (existsSync(WORDS)) {
  const words = readFileSync(WORDS, "utf8").split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (words.length) RULES.push(["개인 단어", new RegExp(words.map(esc).join("|"), "i")]);
} else {
  console.log(`(개인 단어 목록 없음: ${WORDS} — 비밀 키·이메일·경로만 검사)`);
}

// 테스트용 가짜 값(누가 봐도 가짜)은 넘어간다
const FAKE = /me:tok@github.com|abcdefghijklmnop|AKIAABCDEFGHIJKLMNOP|secret_text\("-----BEGIN/;

const files = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => !SKIP.some((r) => r.test(f)));
let hits = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(join(root, f), "utf8");
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of RULES) {
      if (re.test(line) && !FAKE.test(line)) {
        hits++;
        console.log(`${f}:${i + 1}  [${name}]  ${line.trim().slice(0, 120)}`);
      }
    }
  });
}
console.log(hits ? `\n찾음 ${hits}건` : "찾은 것 없음");
process.exit(hits ? 1 : 0);
