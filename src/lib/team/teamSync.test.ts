// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect } from "vitest";
import { syncNote } from "./teamSync";

describe("syncNote", () => {
  it("충돌이면 그 파일과 푸는 방법을 지시 앞에 붙인다", () => {
    expect(syncNote("main", "CONFLICT: a.cs, b.cs")).toBe("[앱] 원래 브랜치(main)를 합치다 충돌이 났다(파일: a.cs, b.cs). 먼저 git merge main로 합치고 충돌을 푼 뒤 아래 일을 하라.");
  });
  it("충돌이 아닌 실패면 맞추라고만", () => {
    expect(syncNote("main", "lock")).toBe("[앱] 원래 브랜치(main)를 합치지 못했다(lock). 먼저 git merge main로 맞춘 뒤 아래 일을 하라.");
  });
});
