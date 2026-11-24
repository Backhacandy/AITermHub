// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 탭의 에이전트 하나(Claude 또는 Codex 프로세스 하나)가 지키는 약속. 에이전트 모듈(claudeLane·codexLane)이 구현하고 TeamView가 묶는다.
import type { AuthWaiter } from "$lib/work/authWait";
import type { Work } from "$lib/work/work.svelte";
import type { WorkIO } from "$lib/work/types";
import type { Settings } from "$lib/settings.svelte";
import type { Member } from "./team";

export interface LaneDeps {
  invoke: (cmd: string, args?: any) => Promise<any>;
  listen: (ev: string, cb: (e: { payload: any }) => void) => Promise<() => void>;
  io?: WorkIO;
  /** 로그인이 풀렸을 때 기다리기(기본: 앱 전체에서 하나) */
  auth?: AuthWaiter;
}

export interface LaneOpts {
  tabId: string;
  dir: string;
  member: Member;
  deps: LaneDeps;
  settings: Settings;
  /** 시작할 때 브라우저(Claude in Chrome)를 쓸지 — 팀의 운영 방식·역할. 없으면 member.chrome, 그것도 없으면 설정 */
  chrome?: () => boolean | null;
  /** 팀원(팀장 말고)은 첫 지시를 받을 때 프로세스를 띄운다 — 켜자마자 수십 개가 떠 메모리를 다 쓰지 않게 */
  lazy?: boolean;
}

export interface LaneState {
  /** 프로세스가 지시를 받을 수 있음 */
  ready: boolean;
  /** 프로세스가 지금 답을 만드는 중(스스로 이어 답하는 것 포함) */
  running: boolean;
  /** 우리가 보낸 지시를 처리 중(send ~ onFinish) */
  busy: boolean;
  /** "이전 대화 n개" / "새 대화" */
  memory: string;
  ctx: number;
  ctxLimit: number;
  /** 백그라운드 작업 수(빌드 등, Claude만) */
  bg: number;
  /** 프로세스가 떠 있음(Claude: 띄운 뒤 끄기 전까지, Codex는 차례마다 띄우므로 늘 false) — 떠 있는 동안은 작업 폴더를 지우지 않는다 */
  live: boolean;
  /** 출력 없이 조용한 지 몇 분(0 = 정상). 명령이 제한을 넘겨 멈춘 것 같을 때 "응답 없음"으로 보인다 */
  quietMin: number;
}

export interface Lane {
  readonly member: Member;
  readonly work: Work;
  readonly state: LaneState;
  /** 프로세스 id `${tabId}~${member.id}` */
  readonly pid: string;
  sessionId(): string | null;
  /** 파일 감시 변경을 이 에이전트 화면에 붙일 때 쓰는 꼬리표 */
  tag(): string;
  /** 이벤트 구독(시작 전에 한 번) */
  init(): Promise<void>;
  /** pick: 고른 대화(null = 새 대화). 없으면 member.resume → 폴더의 최근 대화 */
  start(pick?: string | null): Promise<void>;
  /** 지시 보내기(prompt = 실제로 보낼 글, text = 사용자가 쓴 지시 — 자동 모델 판단용) */
  send(prompt: string, text: string): Promise<void>;
  /** 일하는 중에 보낸 말: Claude는 바로 반영, Codex는 끝나면 이어서 */
  interject(text: string): void;
  stop(): Promise<void>;
  pickSession(sel: string | null): Promise<void>;
  setModel(model: string): void;
  /** 생각 깊이("" = 설정 파일 값). Claude는 다음 지시 때 같은 대화로 다시 시작, Codex는 다음 지시부터 */
  setEffort(effort: string): void;
  /** 30초마다: 쉬면 재우고, 오래 쉬면 끄기 */
  tick(): void;
  dispose(): void;
  /**
   * 지시 하나가 끝남(한도 전환·압축 뒤 다시 보내기·받아 둔 말 이어 보내기는 안에서 처리).
   * full: 그 지시 동안 쓴 글 전부(인계가 중간에 있거나 이어 보낸 말이 있었을 때 인계를 놓치지 않게)
   */
  onFinish: ((answer: string, full?: string) => void) | null;
  /** 지시 없이 스스로 이어 답한 차례(백그라운드 작업이 끝난 뒤 마무리 등)의 글 — 인계를 넘기는 데 쓴다 */
  onLate: ((full: string) => void) | null;
  /** 대화 id가 정해지거나 바뀜(prev가 있으면 다른 대화로 바뀐 것) */
  onSession: ((id: string, prev: string | null) => void) | null;
  /** 압축이 끝나 미뤄 둔 지시를 다시 보내기 직전 — 역할 안내를 다시 붙일 수 있게 */
  onCompacted: ((queued: string) => string) | null;
  /** 일 도중 스스로 압축함 — 다음 지시에 역할 안내를 다시 붙이게 */
  onAutoCompacted: (() => void) | null;
  /** 제한을 한참 넘긴 명령을 앱이 멈춤 — 그 명령(앞부분) */
  onUnstuck: ((cmd: string) => void) | null;
  /** 한도가 다 됐는데 바꿀 계정이 없음 */
  onLimitOut: (() => void) | null;
}
