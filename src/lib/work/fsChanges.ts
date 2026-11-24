// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 파일 감시자(work-fs-change)가 알려준 변경을 목록·라이브 뷰·로그에 반영.
import type { Work } from "./work.svelte";
import type { FsChange, WorkIO } from "./types";
import { fileKey, relLabel, diffMeta } from "./fileList";

/** 도구가 방금 확정한 파일은 이 시간(ms) 동안 감시 이벤트를 무시(같은 변경 중복 처리 방지). */
const TOOL_GRACE_MS = 2000;

/** 한 번에 이보다 많이 바뀌면 빌드 산출물로 보고 읽지 않는다(파일마다 git·읽기를 돌리면 앱이 멈춘다) */
export const BULK = 40;
const bulkNoted = new WeakMap<Work, number>();

export async function applyFsChanges(
  work: Work,
  cwd: string,
  changes: FsChange[],
  io: WorkIO,
  logPrefix?: string,
  now = Date.now()
): Promise<void> {
  if (changes.length > BULK) {
    // 같은 빌드가 계속 쏟아내도 안내는 30초에 한 번만
    if (now - (bulkNoted.get(work) ?? 0) > 30_000) {
      bulkNoted.set(work, now);
      work.note(`— 파일 ${changes.length}개 이상이 한꺼번에 바뀌었어요(빌드 산출물로 보여 목록에 넣지 않아요) —`);
    }
    return;
  }
  for (const ch of changes) {
    const key = fileKey(ch.path);
    const ex = work.findFile(key);
    if (ex && (ex.writing || (ex.settledAt && now - ex.settledAt < TOOL_GRACE_MS))) continue;
    if (ch.kind === "remove" && !ex) continue; // 임시 파일 등 처음 보는 파일의 삭제는 무시

    const label = relLabel(cwd, ch.path);
    const f = work.touch({ key, kind: "edit", label, path: ch.path });
    if (ch.kind === "remove") {
      f.prev = f.content;
      work.settle(key, "");
      f.note = "삭제됨";
    } else {
      if (f.origin === undefined) {
        f.origin = ch.kind === "create" ? "" : await io.baseline(ch.path);
        f.prev = f.origin;
        if (f.origin === null) f.note = "이전 내용 없음";
      } else {
        f.prev = f.binary ? null : f.content;
      }
      const r = await io.read(ch.path);
      work.settleRead(key, r);
      if (!r) continue;
    }
    if (logPrefix !== undefined) {
      work.tool(`${logPrefix}:${key}`, "edit", label, f.status, key);
      work.toolStatus(`${logPrefix}:${key}`, f.status, f.note === "삭제됨" ? "삭제" : diffMeta(f));
    }
  }
}
