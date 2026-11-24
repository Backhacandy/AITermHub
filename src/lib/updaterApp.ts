// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 실제 업데이트 연결: Tauri updater·process 플러그인과 "일하는 중" 표시를 updater.svelte.ts에 넣어 준다.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { working, background } from "./stats.svelte";
import { isBusy } from "./updater.svelte";
import type { UpdateDeps } from "./updater.svelte";

let pending: Update | null = null;

export const appUpdateDeps: UpdateDeps = {
  check: async () => {
    pending = await check();
    return pending ? { version: pending.version } : null;
  },
  install: async () => {
    if (!pending) throw new Error("받을 업데이트가 없어요");
    await pending.downloadAndInstall();
  },
  relaunch: () => relaunch(),
  busy: () => isBusy(working, background),
};
