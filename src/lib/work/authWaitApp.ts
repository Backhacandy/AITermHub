// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 앱 전체에서 하나: Claude 로그인이 풀리면 로그인 창을 한 번 열고, 다시 로그인되면 멈춘 세션들을 차례로 이어서 하게 한다.
import { invoke } from "@tauri-apps/api/core";
import { addSession } from "$lib/sessions.svelte";
import { loginSpec } from "$lib/accounts.svelte";
import { notify } from "$lib/notify";
import { createAuthWaiter } from "./authWait";

export const authWaiter = createAuthWaiter({
  stamp: (account) => invoke<number | null>("claude_login_stamp", { account }),
  openLogin: (account) => {
    void (async () => {
      const sp = account ? await loginSpec(account).catch(() => null) : null;
      addSession({
        title: "Claude 다시 로그인",
        preset: "claude",
        program: sp?.program ?? "cmd.exe",
        args: sp?.args ?? ["/k", "claude auth login"],
        cwd: sp?.cwd ?? undefined,
        env: sp?.env,
        kind: "term",
        transient: true,
      });
    })();
  },
  alert: (text) => notify({ kind: "error", title: "Claude 로그인", body: text }),
});
