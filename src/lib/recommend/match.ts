// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 추천 패널 규칙(토큰 0, 로컬): 프로젝트 신호 + 설치할 수 있는 플러그인 목록 → 설치하면 좋은 것 / 꺼져 있는 것 / 쓰는 중,
// 그리고 설치된 스킬 중 이 프로젝트에 쓸 만한 것. 목록(마켓 사본)에 없는 플러그인은 추천하지 않는다.

export interface CatalogItem {
  name: string;
  market: string;
  description: string;
  category: string | null;
  installs: number | null;
  /** 켜 두면 매 세션 늘 올라가는 토큰(추정) */
  always_on: number | null;
  skills: string[];
}
export interface SkillInfo {
  name: string;
  description: string;
  plugin: string | null;
}
export interface Scan {
  signals: string[];
  claude_md_bytes: number;
  has_git: boolean;
  transcript_bytes: number;
  catalog: CatalogItem[];
  installed: string[];
  enabled: string[];
  skills: SkillInfo[];
}

export type State = "missing" | "off" | "on";
export interface Reco extends CatalogItem {
  id: string;
  why: string;
  state: State;
}

type When = string[] | "always" | "git" | "claudemd";
interface Rule {
  when: When;
  plugins: string[];
  why: string;
}

const WEB = ["svelte", "react", "vue", "next", "angular"];

/** 위에 있을수록 먼저(프로젝트 전용 → 공통) */
const RULES: Rule[] = [
  { when: ["unity"], plugins: ["unity"], why: "Unity 공식 — 게임 개발·최적화 스킬과 에디터 제어(unity-cli)" },
  { when: ["unreal"], plugins: ["unreal-engine-skills-for-claude-code"], why: "언리얼 엔진 작업 스킬" },
  { when: ["csharp"], plugins: ["csharp-lsp"], why: "C# 정의·참조를 LSP로 찾아 파일을 통째로 읽지 않아요 → 토큰↓" },
  { when: ["rust"], plugins: ["rust-analyzer-lsp"], why: "Rust 정의·참조·타입을 LSP로 → 파일 통째 읽기↓" },
  { when: ["typescript", "node"], plugins: ["typescript-lsp"], why: "TS/JS 정의·참조를 LSP로 → 파일 통째 읽기↓" },
  { when: ["python"], plugins: ["pyright-lsp"], why: "Python 타입·정의를 LSP로 → 파일 통째 읽기↓" },
  { when: ["go"], plugins: ["gopls-lsp"], why: "Go 정의·참조를 LSP로" },
  { when: ["java"], plugins: ["jdtls-lsp"], why: "Java 정의·참조를 LSP로" },
  { when: ["kotlin", "android"], plugins: ["kotlin-lsp"], why: "Kotlin 정의·참조를 LSP로" },
  { when: ["swift"], plugins: ["swift-lsp"], why: "Swift 정의·참조를 LSP로" },
  { when: ["cpp", "unreal"], plugins: ["clangd-lsp"], why: "C/C++ 정의·참조를 LSP로" },
  { when: ["php"], plugins: ["php-lsp"], why: "PHP 정의·참조를 LSP로" },
  { when: ["laravel"], plugins: ["laravel-boost"], why: "Laravel 작업 도구" },
  { when: ["ruby"], plugins: ["ruby-lsp"], why: "Ruby 정의·참조를 LSP로" },
  { when: ["lua"], plugins: ["lua-lsp"], why: "Lua 정의·참조를 LSP로" },
  { when: WEB, plugins: ["frontend-design"], why: "흔한 AI 티 안 나는, 완성도 있는 화면 만들기" },
  { when: WEB, plugins: ["playwright"], why: "브라우저로 실제 화면을 띄워 확인·E2E 테스트" },
  { when: ["prisma"], plugins: ["prisma"], why: "Prisma 스키마·마이그레이션" },
  { when: ["supabase"], plugins: ["supabase"], why: "Supabase DB·인증 작업" },
  { when: ["firebase"], plugins: ["firebase"], why: "Firebase 작업" },
  { when: ["stripe"], plugins: ["stripe"], why: "Stripe 결제 연동" },
  { when: ["sentry"], plugins: ["sentry"], why: "Sentry 오류 확인" },
  { when: ["mongodb"], plugins: ["mongodb"], why: "MongoDB 작업" },
  { when: ["redis"], plugins: ["redis-development"], why: "Redis 작업" },
  { when: ["expo"], plugins: ["expo"], why: "Expo(React Native) 작업" },
  { when: ["terraform"], plugins: ["terraform"], why: "Terraform 인프라 작업" },
  { when: ["next", "vercel"], plugins: ["vercel"], why: "Vercel 배포" },
  { when: ["netlify"], plugins: ["netlify-skills"], why: "Netlify 배포" },
  { when: ["cloudflare"], plugins: ["cloudflare"], why: "Cloudflare 작업" },
  { when: ["github"], plugins: ["github"], why: "이슈·PR을 대화에서 바로" },
  { when: "always", plugins: ["superpowers"], why: "체계적 디버깅·TDD·계획 워크플로 — 추측·되돌리기 반복을 줄여요" },
  { when: "git", plugins: ["commit-commands"], why: "커밋·PR 만들기를 명령 하나로" },
  { when: "git", plugins: ["code-review"], why: "바뀐 코드 리뷰" },
  { when: "claudemd", plugins: ["claude-md-management"], why: "CLAUDE.md를 정리해 짧게 — 매 세션 토큰↓" },
  { when: "always", plugins: ["context7"], why: "라이브러리 최신 문서를 찾아 써서 옛 API로 헤매는 걸 줄여요" },
  { when: "always", plugins: ["security-guidance"], why: "코드를 고칠 때 보안 실수를 미리 경고" },
];

function applies(w: When, s: Scan): boolean {
  if (w === "always") return true;
  if (w === "git") return s.has_git;
  if (w === "claudemd") return s.claude_md_bytes > 0;
  return w.some((x) => s.signals.includes(x));
}

const idOf = (c: CatalogItem) => `${c.name}@${c.market}`;
export function stateOf(s: Scan, c: CatalogItem): State {
  const id = idOf(c);
  if (!s.installed.includes(id)) return "missing";
  return s.enabled.includes(id) ? "on" : "off";
}

/** 이름으로 목록에서 찾기(공식 마켓 우선) */
function find(s: Scan, name: string): CatalogItem | undefined {
  const all = s.catalog.filter((c) => c.name === name);
  return all.find((c) => c.market === "claude-plugins-official") ?? all[0];
}

export function recommend(s: Scan): { missing: Reco[]; off: Reco[]; on: Reco[] } {
  const out: Reco[] = [];
  for (const r of RULES) {
    if (!applies(r.when, s)) continue;
    for (const name of r.plugins) {
      const c = find(s, name);
      if (!c || out.some((x) => x.id === idOf(c))) continue;
      out.push({ ...c, id: idOf(c), why: r.why, state: stateOf(s, c) });
    }
  }
  return { missing: out.filter((x) => x.state === "missing"), off: out.filter((x) => x.state === "off"), on: out.filter((x) => x.state === "on") };
}

/** 신호 → 스킬 이름·설명에서 찾을 말 */
const SKILL_WORDS: Record<string, string[]> = {
  unity: ["unity"],
  unreal: ["unreal"],
  csharp: ["c#", "csharp"],
  rust: ["rust", "cargo"],
  tauri: ["tauri"],
  svelte: ["svelte", "frontend"],
  react: ["react", "frontend"],
  vue: ["vue", "frontend"],
  next: ["next.js", "frontend"],
  python: ["python"],
  github: ["github", "pull request"],
  docker: ["docker"],
  sql: ["sql", "database"],
};
/** 어떤 프로젝트에서나 쓸 만한 스킬(설치돼 있으면) */
const GENERAL = ["systematic-debugging", "test-driven-development", "brainstorming", "writing-plans", "verification-before-completion"];

export function skillsFor(s: Scan, max = 8): SkillInfo[] {
  const words = s.signals.flatMap((x) => SKILL_WORDS[x] ?? []);
  const text = (k: SkillInfo) => `${k.name} ${k.description}`.toLowerCase();
  const fit = s.skills.filter((k) => words.some((w) => text(k).includes(w)));
  const general = GENERAL.map((n) => s.skills.find((k) => k.name === n)).filter((k): k is SkillInfo => !!k && !fit.includes(k));
  return [...fit, ...general].slice(0, max);
}

const words = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** 전체 목록에서 찾기: 낱말마다 이름·설명·스킬·분류·마켓 중 어디엔가 있어야 한다. 이름에 맞은 것·많이 깐 것 먼저 */
export function searchCatalog(s: Scan, q: string, max = 30): (CatalogItem & { id: string; state: State })[] {
  const ws = words(q);
  if (!ws.length) return [];
  const hay = (c: CatalogItem) => [c.name, c.description, c.category ?? "", c.market, ...c.skills].join(" ").toLowerCase();
  const inName = (c: CatalogItem) => Number(ws.some((w) => c.name.toLowerCase().includes(w)));
  return s.catalog
    .filter((c) => ws.every((w) => hay(c).includes(w)))
    .sort((a, b) => inName(b) - inName(a) || (b.installs ?? 0) - (a.installs ?? 0))
    .slice(0, max)
    .map((c) => ({ ...c, id: idOf(c), state: stateOf(s, c) }));
}

/** 설치된 스킬에서 찾기 */
export function searchSkills(s: Scan, q: string, max = 10): SkillInfo[] {
  const ws = words(q);
  if (!ws.length) return [];
  return s.skills.filter((k) => ws.every((w) => `${k.name} ${k.description} ${k.plugin ?? ""}`.toLowerCase().includes(w))).slice(0, max);
}

/** 목록에 없어도 바로 쓸 수 있는 입력: "이름@마켓"은 플러그인 설치, "owner/repo"·URL·경로는 마켓 추가 */
export type Direct = { kind: "plugin"; id: string } | { kind: "market"; source: string };
export function directOf(q: string): Direct | null {
  const t = q.trim();
  if (/^[\w.-]+@[\w.-]+$/.test(t)) return { kind: "plugin", id: t };
  if (/^[\w.-]+\/[\w.-]+$/.test(t) || /^(https?:\/\/|git@)\S+$/.test(t) || /^([a-zA-Z]:\\|\.{0,2}\/)\S*$/.test(t)) return { kind: "market", source: t };
  return null;
}

/** "약 3.5k" */
export function fmtTokens(n: number | null | undefined): string {
  if (!n) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;
}
