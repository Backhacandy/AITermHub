// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 소유권: 티켓이 수정할 수 있는 경로(glob)와 겹침 판단.
// 경로는 저장소 기준 `/` 구분, Windows라서 대소문자는 무시한다.

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** glob → 정규식: `**` = 하위 전부, `*` = 한 단계 안, `?` = 한 글자 */
export function globToRegex(glob: string): RegExp {
  const g = norm(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      // "a/**/b"의 "**/"는 0단계도 허용
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchOwns(path: string, owns: string[]): boolean {
  const p = norm(path);
  return owns.some((g) => globToRegex(g).test(p));
}

/** 와일드카드 앞까지의 고정 접두사 */
function literalPrefix(glob: string): string {
  const g = norm(glob);
  const i = g.search(/[*?]/);
  return i < 0 ? g : g.slice(0, i);
}

/**
 * 두 소유 목록이 겹칠 수 있는지(보수적): 고정 접두사 하나가 다른 쪽의 접두사이면 겹친다고 본다.
 * 겹치면 스케줄러가 동시에 돌리지 않는다(순서대로 실행 — 틀려도 안전한 쪽).
 */
export function ownsOverlap(a: string[], b: string[]): boolean {
  for (const x of a)
    for (const y of b) {
      const px = literalPrefix(x);
      const py = literalPrefix(y);
      const wildX = px !== norm(x);
      const wildY = py !== norm(y);
      if (!wildX && !wildY) {
        if (px === py) return true;
      } else if (!wildX) {
        if (globToRegex(y).test(px) || px.startsWith(py)) return true;
      } else if (!wildY) {
        if (globToRegex(x).test(py) || py.startsWith(px)) return true;
      } else if (px.startsWith(py) || py.startsWith(px)) return true;
    }
  return false;
}

/** 바뀐 파일 중 소유 범위 밖인 것 */
export function violations(changed: string[], owns: string[]): string[] {
  return changed.filter((p) => !matchOwns(p, owns));
}
