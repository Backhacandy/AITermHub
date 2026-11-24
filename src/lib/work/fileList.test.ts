// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { touchFile, MAX_FILES, relTime, fileKey, relLabel, absPath, shortCommand } from "./fileList";
import type { FileEntry } from "./types";

describe("touchFile", () => {
  it("새 항목은 맨 앞, 같은 key는 하나로 합쳐 맨 앞으로", () => {
    const list: FileEntry[] = [];
    touchFile(list, { key: "a", kind: "edit", label: "a" }, 1);
    touchFile(list, { key: "b", kind: "read", label: "b" }, 2);
    const a = touchFile(list, { key: "a", kind: "read", label: "a" }, 3);
    expect(list.map((f) => f.key)).toEqual(["a", "b"]);
    expect(a.touchedAt).toBe(3);
    expect(a.kind).toBe("edit"); // 읽기가 수정을 덮지 않는다
  });
  it("읽기 항목을 수정하면 kind가 edit로 올라간다", () => {
    const list: FileEntry[] = [];
    touchFile(list, { key: "a", kind: "read", label: "a" }, 1);
    expect(touchFile(list, { key: "a", kind: "edit", label: "a" }, 2).kind).toBe("edit");
  });
  it("update 콜백이 적용되고 기본값이 채워진다", () => {
    const list: FileEntry[] = [];
    const f = touchFile(list, { key: "a", kind: "edit", label: "a" }, 1, (x) => (x.content = "hi"));
    expect(f).toMatchObject({ content: "hi", writing: false, added: 0, removed: 0, status: "running", origin: undefined });
  });
  it("상한을 넘으면 오래된 것부터 제거", () => {
    const list: FileEntry[] = [];
    for (let i = 0; i < MAX_FILES + 5; i++) touchFile(list, { key: `k${i}`, kind: "read", label: "" }, i);
    expect(list.length).toBe(MAX_FILES);
    expect(list[0].key).toBe(`k${MAX_FILES + 4}`);
    expect(list.some((f) => f.key === "k0")).toBe(false);
  });
});

describe("표시 도우미", () => {
  it("relTime", () => {
    expect(relTime(0, 30_000)).toBe("방금");
    expect(relTime(0, 5 * 60_000)).toBe("5분");
    expect(relTime(0, 3 * 3_600_000)).toBe("3시간");
    expect(relTime(0, 2 * 86_400_000)).toBe("2일");
  });
  it("fileKey는 대소문자·구분자를 통일", () => {
    expect(fileKey("C:\\Proj\\A.ts")).toBe(fileKey("c:/proj/a.ts"));
  });
  it("relLabel은 cwd 기준 상대경로", () => {
    expect(relLabel("C:\\Proj", "c:\\proj\\src\\a.ts")).toBe("src/a.ts");
    expect(relLabel("C:\\Proj", "D:\\x\\a.ts")).toBe("D:/x/a.ts");
  });
  it("absPath", () => {
    expect(absPath("C:\\Proj\\", "src/a.ts")).toBe("C:\\Proj\\src\\a.ts");
    expect(absPath("C:\\Proj", "D:\\a.ts")).toBe("D:\\a.ts");
  });
  it("shortCommand는 PowerShell 감싸기를 벗기고 첫 줄만", () => {
    const ps = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Get-Content -LiteralPath 'a.txt'"`;
    expect(shortCommand(ps)).toBe("Get-Content -LiteralPath 'a.txt'");
    expect(shortCommand("npm run build\necho done")).toBe("npm run build …");
    expect(shortCommand("x".repeat(200), 10)).toBe("xxxxxxxxx…");
  });
});
