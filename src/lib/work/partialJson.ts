// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 스트리밍 중인(아직 끝나지 않은) JSON 객체에서 최상위 문자열 필드를 꺼낸다.
// Claude 도구 입력(input_json_delta)과 로컬 에이전트 출력에서 "지금까지 쓴 내용"을 보여주는 데 쓴다.

export interface Extracted {
  value: string;
  /** 닫는 따옴표까지 받았는지 */
  complete: boolean;
}

const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\n" || s[i] === "\r" || s[i] === "\t")) i++;
  return i;
}

/** s[i] === '"'에서 시작하는 문자열을 읽는다. end = 닫는 따옴표 다음 위치. */
function readString(s: string, i: number): { value: string; complete: boolean; end: number } {
  let out = "";
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { value: out, complete: true, end: i + 1 };
    if (c === "\\") {
      if (i + 1 >= s.length) break;
      const e = s[i + 1];
      if (e === "u") {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ESC[e] ?? e;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, complete: false, end: s.length };
}

/** 값 하나를 건너뛴다. 아직 끝나지 않았으면 -1. */
function skipValue(s: string, i: number): number {
  if (s[i] === '"') {
    const r = readString(s, i);
    return r.complete ? r.end : -1;
  }
  if (s[i] === "{" || s[i] === "[") {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        const r = readString(s, i);
        if (!r.complete) return -1;
        i = r.end;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }
  while (i < s.length && s[i] !== "," && s[i] !== "}" && !/\s/.test(s[i])) i++;
  return i < s.length ? i : -1;
}

export function extractStringField(src: string, key: string): Extracted | null {
  let i = src.indexOf("{");
  if (i < 0) return null;
  i++;
  while (i < src.length) {
    i = skipWs(src, i);
    if (i >= src.length || src[i] === "}") return null;
    if (src[i] === ",") {
      i++;
      continue;
    }
    if (src[i] !== '"') return null;
    const k = readString(src, i);
    if (!k.complete) return null;
    i = skipWs(src, k.end);
    if (src[i] !== ":") return null;
    i = skipWs(src, i + 1);
    if (i >= src.length) return null;
    if (k.value === key) {
      if (src[i] !== '"') return null;
      const v = readString(src, i);
      return { value: v.value, complete: v.complete };
    }
    i = skipValue(src, i);
    if (i < 0) return null;
  }
  return null;
}
