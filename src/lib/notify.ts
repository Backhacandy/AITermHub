// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 알림: 작업이 끝나거나(완료·오류) 입력이 필요하거나(승인 대기) 한도가 소진되면 PC 알림 + (켜 두면) 폰 푸시(ntfy).
// 보고 있는 탭의 짧은 작업은 알리지 않는다. 폰 푸시에는 프로젝트·상태만 보내고 답변 내용은 보내지 않는다.
import { invoke } from "@tauri-apps/api/core";
import { settings } from "$lib/settings.svelte";
import { active, tabs } from "$lib/sessions.svelte";

export type NotifyKind = "done" | "error" | "limit" | "input";

export interface Notice {
  kind: NotifyKind;
  /** 예: "MyGame · Claude" */
  title: string;
  /** PC 알림에만 붙는 짧은 내용(답변 첫 줄 등) */
  body?: string;
  /** 이 알림을 낸 탭 — 그 탭을 보고 있으면 알리지 않음 */
  tabId?: string;
  /** 작업 시작 시각(ms) — 짧은 작업 완료는 알리지 않음 */
  startedAt?: number;
}

/** 이보다 짧게 끝난 작업의 "완료"는 알리지 않는다 */
export const MIN_DONE_MS = 20_000;

export const KIND_LABEL: Record<NotifyKind, string> = {
  done: "완료",
  error: "오류",
  limit: "한도 소진",
  input: "확인 필요",
};

/** 알릴지 판단(순수 함수). watching = 사용자가 지금 그 탭을 보고 있음 */
export function shouldNotify(n: Notice, now: number, watching: boolean): boolean {
  if (watching) return false;
  if (n.kind === "done" && n.startedAt !== undefined && now - n.startedAt < MIN_DONE_MS) return false;
  return true;
}

/** PC 알림 본문: 한 줄, 최대 120자 */
export function shortBody(text: string | undefined): string {
  const line = (text ?? "").replace(/[#*`>_]/g, "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

/** 탭 제목("Claude · MyGame")에서 알림 제목 만들기 */
export function titleFor(tabId: string | undefined, fallback: string): string {
  const t = tabId ? tabs.find((x) => x.id === tabId) : undefined;
  if (!t) return fallback;
  const [agent, folder] = t.title.split(" · ");
  return folder ? `${folder} · ${agent}` : t.title;
}

/** AI 회사 탭 id(알림을 그 탭을 보고 있을 때만 생략) */
export function companyTabId(): string | undefined {
  return tabs.find((t) => t.kind === "company")?.id;
}

function watching(tabId?: string): boolean {
  try {
    return typeof document !== "undefined" && document.hasFocus() && (!tabId || active.id === tabId);
  } catch {
    return false;
  }
}

let permission: Promise<boolean> | null = null;
async function desktop(title: string, body: string) {
  try {
    const m = await import("@tauri-apps/plugin-notification");
    permission ??= (async () => (await m.isPermissionGranted()) || (await m.requestPermission()) === "granted")();
    if (await permission) m.sendNotification({ title, body });
  } catch {
    /* 알림을 못 띄워도 작업에는 영향 없음 */
  }
}

export function push(title: string, body: string, priority = 3): Promise<void> {
  return invoke("notify_push", {
    server: settings.pushServer || "https://ntfy.sh",
    topic: settings.pushTopic ?? "",
    title,
    body,
    priority,
  });
}

export function notify(n: Notice) {
  if (!shouldNotify(n, Date.now(), watching(n.tabId))) return;
  const label = KIND_LABEL[n.kind];
  if (settings.notifyDesktop !== false) void desktop(`${n.title} ${label}`, shortBody(n.body) || label);
  if (settings.pushOn && settings.pushTopic) {
    void push(n.title, label, n.kind === "done" ? 3 : 4).catch(() => {});
  }
}

/** 추측하기 어려운 ntfy 주제 이름 */
export function randomTopic(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return "aith-" + Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}
