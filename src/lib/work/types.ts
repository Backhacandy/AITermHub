// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 작업 화면 공통 타입: 왼쪽 로그(LogEntry)와 오른쪽 파일/명령 항목(FileEntry).

export type Status = "running" | "done" | "error" | "pending" | "rejected";
export type FileKind = "edit" | "read" | "run";
export type ToolVerb = "read" | "edit" | "run" | "other";
export type LogKind = "user" | "ai" | "tool" | "error" | "note";

export interface LogEntry {
  key: string;
  kind: LogKind;
  /** user/ai/error/note: 본문 · tool: 대상(파일 상대경로·명령·도구 이름) */
  text: string;
  verb?: ToolVerb;
  status?: Status;
  /** 클릭 시 오른쪽에 띄울 FileEntry.key */
  fileKey?: string;
  /** 오른쪽 끝 요약(예: "+6 −0", "종료 0") */
  meta?: string;
  /** 승인 대기 버튼(로컬 에이전트) */
  approve?: (ok: boolean) => void;
}

export interface FileEntry {
  /** 파일: fileKey(경로) · 명령: "cmd:<id>" */
  key: string;
  kind: FileKind;
  label: string;
  path?: string;
  status: Status;
  touchedAt: number;
  /** 세션에서 처음 알게 된 이전 내용 — +/− 기준. undefined=아직 모름(조회 전), null=알 수 없음 */
  origin: string | null | undefined;
  /** 이번 변경 직전 내용 — 라이브 뷰 강조 기준. undefined/null이면 강조 없음 */
  prev: string | null | undefined;
  /** 현재(또는 작성 중) 내용. 명령이면 "$ 명령\n출력" */
  content: string;
  writing: boolean;
  added: number;
  removed: number;
  /** 도구가 디스크 내용으로 확정한 시각 — 직후 감시자 이벤트 중복 처리 방지 */
  settledAt?: number;
  /** "이전 내용 없음", "삭제됨", 오류 사유 등 */
  note?: string;
  /** 바이너리 파일(이미지·압축 등) — 내용 대신 안내만 표시 */
  binary?: boolean;
  /** utf-8 / utf-8-bom / utf-16le / cp949 … */
  encoding?: string;
  /** 파일 크기(바이트) */
  size?: number;
}

/** 백엔드 work_read 결과: 바이너리 판별 + 인코딩 디코드 */
export interface ReadResult {
  text: string;
  binary: boolean;
  encoding: string;
  size: number;
}

export interface FsChange {
  path: string;
  kind: "create" | "modify" | "remove";
}

export interface WorkIO {
  /** 파일 내용(없거나 실패하면 null). 바이너리면 binary=true, text="" */
  read(path: string): Promise<ReadResult | null>;
  /** git HEAD 기준 내용(미추적·저장소 아님이면 null) */
  baseline(path: string): Promise<string | null>;
}
