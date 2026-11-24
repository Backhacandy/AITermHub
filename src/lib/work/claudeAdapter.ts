// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Claude stream-json(--include-partial-messages) 이벤트 → 작업 로그 / 라이브 뷰.
// - text_delta: 답변을 글자 단위로 로그에
// - input_json_delta: Write/Edit 내용을 쓰는 도중에 라이브 뷰로
// - tool_result: 도구 완료 → 파일이면 디스크를 다시 읽어 확정(+/−)
import type { Work } from "./work.svelte";
import type { ToolVerb, WorkIO } from "./types";
import { extractStringField } from "./partialJson";
import { fileKey, relLabel, absPath, diffMeta, shortCommand, textOf } from "./fileList";

const EDIT = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"]);
const RUN = new Set(["Bash", "PowerShell", "BashOutput"]);

export function verbOf(name: string): ToolVerb {
  if (EDIT.has(name)) return "edit";
  if (READ.has(name)) return "read";
  if (RUN.has(name)) return "run";
  return "other";
}

interface ToolState {
  name: string;
  verb: ToolVerb;
  json: string;
  path?: string;
  fileKey?: string;
  /** 변경 전 디스크 내용(undefined=읽는 중, null=새 파일) */
  base?: string | null;
  command?: string;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c))).join("\n");
  return JSON.stringify(content ?? "");
}

export function createClaudeAdapter(work: Work, cwd: string, io: WorkIO) {
  let msgId = "";
  /** `${msgId}:${index}` → 로그 key(text) 또는 도구 id */
  const blocks = new Map<string, { kind: "text" | "tool"; key: string }>();
  /** text_delta를 받은 메시지 id — 최종 assistant 텍스트 중복 방지 */
  const streamed = new Set<string>();
  const tools = new Map<string, ToolState>();
  const pending = new Set<Promise<unknown>>();

  function track(p: Promise<unknown>) {
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  function startTool(id: string, name: string) {
    if (tools.has(id)) return;
    const verb = verbOf(name);
    tools.set(id, { name, verb, json: "" });
    work.tool(id, verb, name, "running");
    work.ui.status = `${name} …`;
  }

  function beginFile(id: string, t: ToolState, path: string) {
    t.path = path;
    t.fileKey = fileKey(path);
    const label = relLabel(cwd, path);
    work.tool(id, "edit", label, "running", t.fileKey);
    work.ui.status = `${label} 작성 중`;
    const f = work.touch({ key: t.fileKey, kind: "edit", label, path }, (x) => {
      x.writing = true;
      x.status = "running";
    });
    track(
      io.read(path).then((r) => {
        const before = textOf(r);
        t.base = before;
        f.prev = before ?? "";
        if (f.origin === undefined) f.origin = before ?? "";
        refresh(id);
      })
    );
  }

  /** 누적 JSON으로 라이브 내용 갱신 */
  function refresh(id: string) {
    const t = tools.get(id);
    if (!t?.fileKey) return;
    const f = work.findFile(t.fileKey);
    if (!f || !f.writing) return;
    if (t.name === "Write") {
      const c = extractStringField(t.json, "content");
      if (c) f.content = c.value;
    } else if (t.name === "Edit") {
      const nw = extractStringField(t.json, "new_string");
      if (!nw) return;
      const old = extractStringField(t.json, "old_string");
      const base = t.base;
      f.content =
        typeof base === "string" && old?.complete && old.value && base.includes(old.value)
          ? base.replace(old.value, () => nw.value)
          : nw.value;
    }
    // MultiEdit/NotebookEdit: 작성 중엔 "작성 중…"만, 완료 후 디스크 내용으로 확정
  }

  function onInput(id: string) {
    const t = tools.get(id);
    if (!t) return;
    if (t.verb === "edit") {
      if (!t.path) {
        const p = extractStringField(t.json, "file_path") ?? extractStringField(t.json, "notebook_path");
        if (p?.complete) beginFile(id, t, absPath(cwd, p.value));
      }
      refresh(id);
    } else if (t.verb === "run") {
      const c = extractStringField(t.json, "command");
      if (!c?.complete) return;
      t.command = c.value;
      const key = `cmd:${id}`;
      work.tool(id, "run", shortCommand(c.value), "running", key);
      work.touch({ key, kind: "run", label: shortCommand(c.value, 80) }, (x) => {
        x.content = `$ ${c.value}`;
        x.status = "running";
      });
      work.ui.status = `실행: ${shortCommand(c.value, 60)}`;
    } else if (t.verb === "read") {
      const p =
        extractStringField(t.json, "file_path") ??
        extractStringField(t.json, "pattern") ??
        extractStringField(t.json, "path") ??
        extractStringField(t.json, "url") ??
        extractStringField(t.json, "query");
      if (p?.complete) {
        const isFile = !!extractStringField(t.json, "file_path");
        if (isFile) t.path = absPath(cwd, p.value);
        work.tool(id, "read", isFile ? relLabel(cwd, t.path!) : p.value, "running");
      }
    }
  }

  async function settleFile(id: string, t: ToolState, isError: boolean) {
    if (!t.fileKey || !t.path) return;
    const r = await io.read(t.path);
    const st = isError ? "error" : "done";
    // 다시 읽기에 실패하면 스트리밍으로 받은 내용을 그대로 확정
    const f = r
      ? work.settleRead(t.fileKey, r, st, true)
      : work.settle(t.fileKey, work.findFile(t.fileKey)?.content ?? "", st, true);
    work.toolStatus(id, isError ? "error" : "done", f && !isError ? diffMeta(f) : undefined);
  }

  function onResult(id: string, isError: boolean, content: unknown) {
    const t = tools.get(id);
    if (!t) return;
    work.ui.status = "";
    if (t.verb === "edit") {
      track(settleFile(id, t, isError));
      return;
    }
    const st = isError ? "error" : "done";
    if (t.verb === "run") {
      const key = `cmd:${id}`;
      const cmd = t.command ?? t.name;
      work.touch({ key, kind: "run", label: shortCommand(cmd, 80) }, (x) => {
        x.content = `$ ${cmd}\n${resultText(content)}`.slice(0, 20000);
        x.status = st;
      });
      work.tool(id, "run", shortCommand(cmd), st, key);
      return;
    }
    if (t.verb === "read" && t.path) {
      const path = t.path;
      const key = fileKey(path);
      work.tool(id, "read", relLabel(cwd, path), st, key);
      track(
        io.read(path).then((r) =>
          work.touch(
            { key, kind: "read", label: relLabel(cwd, path), path },
            (x) => {
              if (x.kind === "read") {
                x.content = textOf(r) ?? "";
                x.binary = !!r?.binary;
                x.encoding = r?.encoding;
                x.size = r?.size;
              }
              if (x.status === "running") x.status = r === null ? "error" : "done";
            },
            false
          )
        )
      );
      return;
    }
    work.toolStatus(id, st);
  }

  function handle(ev: any) {
    if (ev?.parent_tool_use_id) return; // 서브에이전트 내부 진행은 생략
    if (ev.type === "stream_event") {
      const e = ev.event ?? {};
      if (e.type === "message_start") {
        msgId = e.message?.id ?? `m${Date.now()}`;
        return;
      }
      const bkey = `${msgId}:${e.index}`;
      if (e.type === "content_block_start") {
        const cb = e.content_block ?? {};
        if (cb.type === "text") {
          blocks.set(bkey, { kind: "text", key: `t:${bkey}` });
          streamed.add(msgId);
        } else if (cb.type === "tool_use") {
          blocks.set(bkey, { kind: "tool", key: cb.id });
          startTool(cb.id, cb.name);
        }
        return;
      }
      if (e.type === "content_block_delta") {
        const b = blocks.get(bkey);
        if (!b) return;
        if (b.kind === "text" && e.delta?.type === "text_delta") work.aiAppend(b.key, e.delta.text ?? "");
        else if (b.kind === "tool" && e.delta?.type === "input_json_delta") {
          const t = tools.get(b.key);
          if (!t) return;
          t.json += e.delta.partial_json ?? "";
          onInput(b.key);
        }
      }
      return;
    }
    if (ev.type === "assistant") {
      const m = ev.message ?? {};
      for (const c of m.content ?? []) {
        if (c.type === "text" && !streamed.has(m.id)) work.aiSet(`a:${ev.uuid ?? m.id}`, c.text ?? "");
        else if (c.type === "tool_use") {
          // 부분 스트림을 놓쳤어도 완성된 입력으로 한 번 더 반영
          startTool(c.id, c.name);
          const t = tools.get(c.id)!;
          t.json = JSON.stringify(c.input ?? {});
          onInput(c.id);
        }
      }
      return;
    }
    if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c?.type === "tool_result") onResult(c.tool_use_id, !!c.is_error, c.content);
      }
    }
  }

  return {
    handle,
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
    reset() {
      blocks.clear();
      tools.clear();
      msgId = "";
    },
  };
}
