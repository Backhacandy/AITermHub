// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 작업 화면 상태 스토어(화면 하나당 하나). 어댑터가 이벤트를 이 함수들로 바꾸고, 컴포넌트는 읽기만 한다.
import { touchFile, type FileInit } from "./fileList";
import { lineDiff } from "./diff";
import type { FileEntry, LogEntry, ReadResult, Status, ToolVerb } from "./types";
import type { LineComment } from "./comments";

let seq = 0;

export function createWork() {
  const log = $state<LogEntry[]>([]);
  const files = $state<FileEntry[]>([]);
  /** 코드 뷰에서 줄에 남긴 리뷰 코멘트 */
  const comments = $state<LineComment[]>([]);
  const ui = $state({
    /** true면 라이브(지금 작업 중인 항목)를 따라감 */
    follow: true,
    /** 사용자가 고른 항목 key(따라가기 해제 상태) */
    selected: null as string | null,
    /** 지금 작업 중인 항목 key */
    live: null as string | null,
    /** 로그 하단 "● 작업 중…" 옆에 보일 현재 작업 */
    status: "",
  });

  const findLog = (key: string) => log.find((e) => e.key === key);
  const findFile = (key: string) => files.find((f) => f.key === key);

  function push(e: Omit<LogEntry, "key"> & { key?: string }): LogEntry {
    log.push({ ...e, key: e.key ?? `l${++seq}` });
    return log[log.length - 1];
  }

  /** 디스크에서 다시 읽은 최종 내용으로 확정하고 +/−를 갱신. byTool이면 직후 감시 이벤트를 건너뛰게 표시. */
  function settle(key: string, content: string, status: Status = "done", byTool = false): FileEntry | undefined {
    const f = findFile(key);
    if (!f) return;
    f.content = content;
    f.writing = false;
    f.status = status;
    if (byTool) f.settledAt = Date.now();
    if (typeof f.origin === "string") {
      const d = lineDiff(f.origin, content);
      f.added = d.added;
      f.removed = d.removed;
    }
    return f;
  }

  /** 읽기 결과(바이너리·인코딩 포함)로 확정. 실패면 오류 표시. */
  function settleRead(key: string, r: ReadResult | null, status: Status = "done", byTool = false): FileEntry | undefined {
    const f = findFile(key);
    if (!f) return;
    if (!r) {
      f.writing = false;
      f.status = "error";
      f.note = "읽기 실패";
      return f;
    }
    f.encoding = r.encoding;
    f.size = r.size;
    f.binary = r.binary;
    if (r.binary) {
      // 바이너리는 줄 비교가 의미 없으므로 +/−를 세지 않는다
      f.origin = null;
      f.prev = null;
      f.added = 0;
      f.removed = 0;
      return settle(key, "", status, byTool);
    }
    return settle(key, r.text, status, byTool);
  }

  return {
    log,
    files,
    comments,
    ui,
    get shown(): FileEntry | null {
      const k = ui.follow ? ui.live : ui.selected;
      return (k && findFile(k)) || null;
    },
    findFile,
    user(text: string) {
      push({ kind: "user", text });
    },
    note(text: string) {
      push({ kind: "note", text });
    },
    error(text: string) {
      push({ kind: "error", text });
    },
    aiAppend(key: string, delta: string) {
      const e = findLog(key);
      if (e) e.text += delta;
      else push({ key, kind: "ai", text: delta });
    },
    aiSet(key: string, text: string) {
      if (!text.trim()) return;
      const e = findLog(key);
      if (e) e.text = text;
      else push({ key, kind: "ai", text });
    },
    tool(key: string, verb: ToolVerb, text: string, status: Status = "running", fileKey?: string): LogEntry {
      const e = findLog(key);
      if (e) {
        e.verb = verb;
        e.text = text;
        e.status = status;
        if (fileKey) e.fileKey = fileKey;
        return e;
      }
      return push({ key, kind: "tool", verb, text, status, fileKey });
    },
    toolStatus(key: string, status: Status, meta?: string) {
      const e = findLog(key);
      if (!e) return;
      e.status = status;
      if (meta !== undefined) e.meta = meta;
    },
    touch(init: FileInit, update?: (f: FileEntry) => void, live = true): FileEntry {
      const f = touchFile(files, init, Date.now(), update);
      if (live) ui.live = f.key;
      return f;
    },
    settle,
    settleRead,
    /** 재시작·중단·오류 시 진행 중 표시를 정리 */
    failRunning() {
      for (const e of log) if (e.kind === "tool" && (e.status === "running" || e.status === "pending")) e.status = "error";
      for (const f of files)
        if (f.writing || f.status === "running") {
          f.writing = false;
          f.status = "error";
        }
      ui.status = "";
    },
    select(key: string) {
      ui.selected = key;
      ui.follow = false;
    },
    resumeLive() {
      ui.follow = true;
    },
    /** 다른 대화로 바꿀 때 화면 비우기 */
    clear() {
      log.length = 0;
      files.length = 0;
      comments.length = 0;
      ui.selected = null;
      ui.live = null;
      ui.status = "";
      ui.follow = true;
    },
  };
}

export type Work = ReturnType<typeof createWork>;
