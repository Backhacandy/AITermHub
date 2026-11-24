// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { withDir, sameDir } from "./remote.svelte";

describe("remote dirs", () => {
  it("같은 폴더(대소문자·끝 슬래시)는 하나로", () => {
    expect(sameDir("C:\Proj\\", "c:\proj")).toBe(true);
    expect(withDir(["C:\Proj"], "c:\proj\\", true)).toEqual(["c:\proj\\"]);
  });
  it("끄면 목록에서 뺀다", () => {
    expect(withDir(["C:\A", "C:\B"], "c:\a", false)).toEqual(["C:\B"]);
  });
});
