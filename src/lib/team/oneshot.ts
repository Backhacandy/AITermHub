// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 분배 담당·팀 구성 제안: 한 번 묻고 구조화 결과를 받는다(분배는 Sonnet, 구성은 Opus). 실패하면 null(부르는 쪽이 물러선다).
import { invoke } from "@tauri-apps/api/core";
import { pickAccount } from "$lib/accounts.svelte";

/** 지시를 에이전트별로 나누는 모델(지시마다 — 정확하면서 몇 초 안에) */
export const DISTRIBUTE_MODEL = "sonnet";
/** 목적을 보고 팀을 구성하는 모델(처음 한 번 — 가장 좋은 모델로) */
export const PROPOSE_MODEL = "opus";

export async function quickJson<T>(cwd: string, system: string, prompt: string, schema: object, model: string = DISTRIBUTE_MODEL): Promise<T | null> {
  try {
    const account = await pickAccount("claude");
    return await invoke<T>("claude_oneshot", { cwd, model, system, prompt, schema, account });
  } catch {
    return null;
  }
}
