// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 실제 업데이트 연결: Tauri updater·process 플러그인과 "일하는 중" 표시를 updater.svelte.ts에 넣어 준다.
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { working, background } from "./stats.svelte";
import { isBusy, installSteps } from "./updater.svelte";
import type { UpdateDeps } from "./updater.svelte";

let pending: Update | null = null;

export const appUpdateDeps: UpdateDeps = {
  check: async () => {
    pending = await check();
    return pending ? { version: pending.version } : null;
  },
  install: async () => {
    const u = pending;
    if (!u) throw new Error("받을 업데이트가 없어요");
    await installSteps({
      download: () => u.download(),
      breakaway: (on) => invoke("update_breakaway", { on }),
      install: () => u.install(),
    });
  },
  relaunch: () => relaunch(),
  busy: () => isBusy(working, background),
};
