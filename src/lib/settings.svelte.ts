// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 전역 설정 스토어 (백엔드 settings.json 과 동기화)
import { flavor } from "./flavor";
import { invoke } from "@tauri-apps/api/core";
import { nameFromId } from "$lib/collab/catalog";
import { setModelLabel } from "$lib/pair/models";

export interface Settings {
  theme: string;
  fontSize: number;
  autoSleep: boolean;
  idleMinutes: number;
  /** 자동 압축 기준: -1 = 비용 비교(지난 대화를 다시 읽는 비용이 압축 비용을 넘으면), 0 = 끔, 1~99 = 컨텍스트가 그 %를 넘으면 */
  compactAt: number;
  /** 설정 형식 버전(2부터 compactAt -1 = 비용 비교) */
  compactV?: number;
  /** 에이전트 전체 권한: Claude 모든 도구 허용, Codex 샌드박스 해제(협업·새 세션·AI 회사 작업자) — 사용자가 직접 켜고 끔 */
  fullAccess: boolean;
  commands: Record<string, string[]>;
  /** 쉬는 Claude 프로세스 내려놓기(기본 켬) · 분(최소 5) */
  releaseIdle?: boolean;
  releaseMinutes?: number;
  /** 저장공간 자동 정리(기본 켬): 에이전트 임시 파일·오래 쉰 팀원 폴더·한 번 쓰고 버린 기록 */
  storageAuto?: boolean;
  /** 깨끗한 팀원 폴더를 통째로 지우기까지 쉰 시간(기본 6) · 그 밖의 폴더에서 Library·빌드만 지우기까지(기본 24) */
  wtCleanHours?: number;
  wtDirtyHours?: number;
  /** 디스크 경보(기본 10GB 아래면 바로 정리) · 멈춤(기본 3GB 아래면 팀원 일 기다림) */
  diskWarnGB?: number;
  diskStopGB?: number;
  /** PC 알림(작업 완료·오류·한도 소진) — 기본 켬 */
  notifyDesktop?: boolean;
  /** 폰 푸시(ntfy) 켜기 · 주제 · 서버 */
  pushOn?: boolean;
  pushTopic?: string;
  pushServer?: string;
  /** 폰에서 열 수 있게 켜 둔 프로젝트 폴더(허브를 켤 때 다시 연결) */
  remoteDirs?: string[];
  lastCwd?: string;
  /** 협업 탭 담당 영역을 직접 정한 프로젝트(폴더 → 경로 글롭). 없으면 자동 감지 */
  pairAreas?: Record<string, { front: string[]; back: string[] }>;
  /** 팀 탭: 지시 하나에서 에이전트끼리 요청을 이어 처리하는 후속 최대 횟수(기본 3) · 무제한 */
  followupMax?: number;
  followupUnlimited?: boolean;
  /** Claude 세션에서 Claude in Chrome(브라우저 조작) 쓰기 — 기본 켬, 새로 시작하는 세션부터 */
  claudeChrome?: boolean;
  /** GitHub 잔디 자동 올리기(기본 켬) · 대상 폴더(없으면 기본 목록) */
  grassOn?: boolean;
  grassDirs?: string[];
  /** 포트폴리오: GitHub 프로필 README에 프로젝트 목록 올리기(기본 끔) · 프로젝트별 보이기·이름·설명 · 마지막으로 올린 시각 */
  portfolioOn?: boolean;
  portfolio?: Record<string, { show?: boolean; name?: string; desc?: string }>;
  portfolioAt?: number;
  /** 잔디 커밋 작성자(GitHub noreply 주소 — gh 계정에서 만든다) */
  grassEmail?: string;
  /** 왼쪽에 모바일 원격 아이콘 보이기(폰에서 이어 쓰기) */
  mobileOn?: boolean;
  /** Claude Code·Codex CLI 하루 한 번 자동 업데이트(기본 켬) · 마지막으로 올린 시각 · 결과 한 줄 */
  cliAutoUpdate?: boolean;
  cliUpdateAt?: number;
  cliUpdateLog?: string;
  /** Claude가 알려 준 실제 모델 버전으로 맞춘 이름표(별칭 → "Sonnet 5.5") */
  modelNames?: Record<string, string>;
  /** 새 팀의 운영 방식(기본 라이트) */
  defaultMode?: "lite" | "max";
  /** 실험 기능: 팀·비교 새로 만들기(없으면 개발판 켬·배포판 끔) */
  experimentalTeam?: boolean;
  /** 첫 실행 안내를 마쳤는지 */
  onboarded?: boolean;
}

export const settings = $state<Settings>({
  theme: "dark",
  fontSize: 14,
  autoSleep: true,
  idleMinutes: 15,
  compactAt: -1,
  compactV: 3,
  fullAccess: true,
  commands: {},
  lastCwd: undefined,
});

export async function loadSettings() {
  const s = await invoke<Settings>("settings_get").catch(() => null);
  if (s) Object.assign(settings, s);
  // 배포판: 사용자 PC의 전역 도구를 바꾸거나(CLI 자동 업데이트) 저장소에 올리는(잔디) 기능은 직접 켜기 전까지 끈다
  if (flavor() === "release") {
    settings.cliAutoUpdate ??= false;
    settings.grassOn ??= false;
  }
  for (const [k, v] of Object.entries(settings.modelNames ?? {})) setModelLabel(k, v);
  // 예전 기본값(60% 등)으로 저장된 설정은 비용 비교로 옮긴다(직접 끈 경우는 그대로)
  // 3: 1M 창 모델이 나오면서 % 설정이 지난 대화를 수십만 토큰씩 끌고 다니게 돼 한 번 더 비용 비교로 옮긴다
  if ((settings.compactV ?? 0) < 3) {
    if (settings.compactAt > 0) settings.compactAt = -1;
    settings.compactV = 3;
    if (s) await saveSettings();
  }
}

/** Claude 시작 신호(init)의 실제 모델 이름으로 이름표를 맞춘다. 별칭으로 부른 경우만(requested === 별칭) —
 *  직접 옛 버전을 고른 경우가 별칭 이름표를 바꾸지 않게 */
export function learnModel(requested: string | null | undefined, actual: unknown) {
  if (typeof actual !== "string" || !requested) return;
  const n = nameFromId(actual);
  if (!n || n.key !== requested.toLowerCase()) return;
  if (!setModelLabel(n.key, n.label)) return;
  settings.modelNames = { ...(settings.modelNames ?? {}), [n.key]: n.label };
  void saveSettings();
}

export async function saveSettings() {
  await invoke("settings_save", { value: $state.snapshot(settings) }).catch(() => {});
}
