// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 줄 단위 비교: 앞뒤 공통부를 자르고 가운데만 LCS로 비교한다(편집은 대개 국소적이라 빠름).

export interface LineDiff {
  added: number;
  removed: number;
  /** after 기준 0-based 줄 번호(추가·변경된 줄) */
  changed: number[];
}

/** LCS 표 칸 수 상한(약 4MB). 넘으면 가운데 전체를 변경으로 근사. */
const MAX_CELLS = 1_000_000;

export function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\r\n/g, "\n").split("\n");
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    return { added: m, removed: n, changed: range(pre, pre + m) };
  }

  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);

  const matched = new Uint8Array(m);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      matched[j] = 1;
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
  const lcs = t[0];
  const changed: number[] = [];
  for (let k = 0; k < m; k++) if (!matched[k]) changed.push(pre + k);
  return { added: m - lcs, removed: n - lcs, changed };
}
