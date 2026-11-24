// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { extractStringField as x } from "./partialJson";

describe("extractStringField", () => {
  it("완성된 JSON", () => {
    expect(x(String.raw`{"file_path":"C:\\a.ts","content":"x\ny"}`, "content")).toEqual({ value: "x\ny", complete: true });
    expect(x(String.raw`{"file_path":"C:\\a.ts","content":"x"}`, "file_path")).toEqual({ value: "C:\\a.ts", complete: true });
  });
  it("값이 쓰이는 중", () => {
    expect(x(String.raw`{"file_path":"a.ts","content":"line1\nli`, "content")).toEqual({ value: "line1\nli", complete: false });
  });
  it("끝이 이스케이프 중간이면 거기까지만", () => {
    // 일반 문자열로 쓴다(String.raw는 끝의 \가 닫는 `를 이스케이프해 버림)
    expect(x('{"content":"ab\\', "content")).toEqual({ value: "ab", complete: false });
    expect(x('{"content":"ab\\u00', "content")).toEqual({ value: "ab", complete: false });
  });
  it("유니코드 이스케이프", () => {
    expect(x(String.raw`{"content":"\uD55C\uAE00"}`, "content")).toEqual({ value: "한글", complete: true });
  });
  it("중첩 값은 건너뛴다", () => {
    expect(x(String.raw`{"edits":[{"a":"}"}],"n":12,"ok":true,"content":"ok"}`, "content")).toEqual({ value: "ok", complete: true });
  });
  it("다른 값 안의 키 모양 문자열에 속지 않는다", () => {
    expect(x(String.raw`{"file_path":"\"content\":\"x","content":"real"}`, "content")).toEqual({ value: "real", complete: true });
  });
  it("앞에 설명 문장이 있어도 첫 객체를 해석", () => {
    expect(x(`좋아요: {"action":"write_file","path":"a`, "action")).toEqual({ value: "write_file", complete: true });
  });
  it("없거나 아직 값이 없으면 null", () => {
    expect(x(`{"a":"b"}`, "content")).toBeNull();
    expect(x(`{"content":`, "content")).toBeNull();
    expect(x(`{"n":12`, "content")).toBeNull();
    expect(x(`없음`, "content")).toBeNull();
  });
});
