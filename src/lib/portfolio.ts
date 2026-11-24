// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 포트폴리오: GitHub 프로필 README에 "보이기"로 고른 프로젝트 목록(이름·한 줄 설명·기간·기술·커밋 수)을 갱신한다.
// 앱이 쓰는 부분은 표시(START~END) 사이뿐 — 그 밖의 README 내용은 건드리지 않는다. 처음 보는 프로젝트는 숨김이 기본.

export interface ProjectInfo {
  dir: string;
  name: string;
  first: string;
  last: string;
  commits: number;
  tech: string[];
  readme: string;
}

export interface ProjectPref {
  show?: boolean;
  name?: string;
  desc?: string;
}

export interface PortfolioItem {
  dir: string;
  name: string;
  desc: string;
  period: string;
  tech: string[];
  commits: number;
}

export const START = "<!-- aith:projects:start -->";
export const END = "<!-- aith:projects:end -->";

/** 설정에 저장할 때의 폴더 키(대소문자·구분자·끝 슬래시 무시) */
export const prefKey = (dir: string) => dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const ym = (d: string) => (d ? d.slice(0, 7).replace("-", ".") : "");
function period(first: string, last: string): string {
  const a = ym(first);
  const b = ym(last);
  if (!a) return "";
  return a === b ? a : `${a} ~ ${b}`;
}

/** 보이기로 고른 프로젝트만(최근에 손댄 것부터) */
export function visibleItems(scan: ProjectInfo[], prefs: Record<string, ProjectPref>): PortfolioItem[] {
  return scan
    .filter((p) => prefs[prefKey(p.dir)]?.show === true)
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((p) => {
      const pr = prefs[prefKey(p.dir)] ?? {};
      return { dir: p.dir, name: pr.name?.trim() || p.name, desc: pr.desc?.trim() ?? "", period: period(p.first, p.last), tech: p.tech, commits: p.commits };
    });
}

const cell = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

/** README에 넣을 목록(표). today: 갱신 날짜 */
export function renderBlock(items: PortfolioItem[], today: string): string {
  const rows = items.map((i) => `| ${cell(i.name)} | ${cell(i.desc)} | ${cell(i.period)} | ${cell(i.tech.join(", "))} | ${i.commits} |`);
  return [
    START,
    "### 만든 것들",
    "",
    "| 프로젝트 | 설명 | 기간 | 기술 | 커밋 |",
    "| --- | --- | --- | --- | ---: |",
    ...rows,
    "",
    `<sub>최근 갱신 ${today}</sub>`,
    END,
  ].join("\n");
}

/** 기존 README에 목록을 합친다: 표시 사이만 바꾸고, 없으면 끝에 덧붙이고, README가 없으면 새로.
 *  시작 표시 뒤에 끝 표시가 없으면(누가 지웠거나 순서가 바뀜) 사용자 글을 지울 수 있어 고치지 않고 멈춘다 */
export function mergeReadme(existing: string | null, block: string, login: string): string {
  const cur = existing ?? "";
  const i = cur.indexOf(START);
  if (i >= 0) {
    const j = cur.indexOf(END, i);
    if (j < 0) throw new Error("프로필 README의 목록 표시(aith:projects)가 짝이 맞지 않아요 — README를 직접 확인해 주세요");
    return cur.slice(0, i) + block + cur.slice(j + END.length);
  }
  if (cur.includes(END)) throw new Error("프로필 README의 목록 표시(aith:projects)가 짝이 맞지 않아요 — README를 직접 확인해 주세요");
  if (cur.trim()) return `${cur.replace(/\s+$/, "")}\n\n${block}\n`;
  return `# ${login}\n\n${block}\n`;
}

/** 하루에 한 번 */
export const dueDaily = (last: number | undefined, now: number) => last === undefined || now - last >= 24 * 3600_000;

/** 갱신 날짜 줄을 뺀 목록(같은 목록인지 비교용) */
const withoutDate = (s: string) => s.replace(/<sub>최근 갱신 [^<]*<\/sub>/, "");

/** 올릴지: 보일 게 없으면 이미 올린 목록이 있을 때만(비우기), 목록이 그대로면 올리지 않음(매일 커밋 안 쌓이게) */
export function planPublish(visible: number, existing: string, block: string): "write" | "skip" | "same" {
  const i = existing.indexOf(START);
  const j = i >= 0 ? existing.indexOf(END, i) : -1;
  if (!visible && i < 0) return "skip";
  if (i >= 0 && j > i && withoutDate(existing.slice(i, j + END.length)) === withoutDate(block)) return "same";
  return "write";
}
