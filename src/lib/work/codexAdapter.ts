// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Codex exec --json 이벤트 → 작업 로그 / 라이브 뷰.
// Windows의 Codex는 파일을 PowerShell로 직접 고치므로 파일 변경은 주로 감시자(applyFsChanges)로 잡힌다.
import type { Work } from "./work.svelte";
import type { FsChange, WorkIO } from "./types";
import { applyFsChanges } from "./fsChanges";
import { absPath, shortCommand } from "./fileList";

export function createCodexAdapter(work: Work, cwd: string, io: WorkIO) {
  let turn = 0;
  const pending = new Set<Promise<unknown>>();
  function track(p: Promise<unknown>) {
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  function handle(ev: any) {
    if (ev.type !== "item.started" && ev.type !== "item.completed") return;
    const it = ev.item ?? {};
    const done = ev.type === "item.completed";
    const lk = `${turn}:${it.id}`; // item id는 턴마다 item_0부터 다시 시작한다

    if (it.type === "agent_message") {
      if (done) work.aiSet(lk, it.text ?? "");
    } else if (it.type === "command_execution") {
      const cmd = String(it.command ?? "");
      const key = `cmd:${lk}`;
      const st = !done ? "running" : it.exit_code === 0 ? "done" : "error";
      work.touch({ key, kind: "run", label: shortCommand(cmd, 80) }, (x) => {
        x.status = st;
        x.content = `$ ${cmd}\n${String(it.aggregated_output ?? "")}`.slice(0, 20000);
      });
      work.tool(lk, "run", shortCommand(cmd), st, key);
      if (done) work.toolStatus(lk, st, `종료 ${it.exit_code ?? "?"}`);
      work.ui.status = done ? "" : `실행: ${shortCommand(cmd, 60)}`;
    } else if (it.type === "file_change") {
      if (!done) return;
      const changes: FsChange[] = (it.changes ?? []).map((c: any) => ({
        path: absPath(cwd, String(c.path)),
        kind: c.kind === "add" ? "create" : c.kind === "delete" ? "remove" : "modify",
      }));
      track(applyFsChanges(work, cwd, changes, io, String(turn)));
    } else if (done && it.type && it.type !== "reasoning") {
      work.tool(lk, "other", String(it.type), "done");
    }
  }

  return {
    handle,
    setTurn(n: number) {
      turn = n;
    },
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
