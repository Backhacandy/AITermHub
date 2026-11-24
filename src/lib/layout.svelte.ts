// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 사용자가 마우스로 조절한 영역 크기(모든 탭 공통). 앱을 다시 켜도 유지된다.

const KEY = "aith.layout";

export const LAYOUT_DEFAULTS = {
  /** 구조화 화면: 오른쪽 작업 패널 너비(화면 대비 %) */
  workPanelPct: 44,
  /** 작업 패널 안: 라이브 뷰 높이(라이브+파일 목록 대비 %) */
  livePct: 60,
  /** 오른쪽 사이드 패널(파일·상태·추천) 너비(px) */
  sidePanelPx: 290,
  /** 분할 화면: 왼쪽 열 너비(%) */
  gridColPct: 50,
  /** 4분할: 위쪽 행 높이(%) */
  gridRowPct: 50,
};

export type LayoutKey = keyof typeof LAYOUT_DEFAULTS;

function load(): typeof LAYOUT_DEFAULTS {
  try {
    return { ...LAYOUT_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...LAYOUT_DEFAULTS };
  }
}

export const layout = $state(load());

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** 값을 범위 안으로 맞춰 저장(드래그 중 연속 저장을 피하려고 잠깐 모아서 쓴다). */
export function setLayout(key: LayoutKey, value: number, min: number, max: number) {
  layout[key] = Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      // 저장 실패는 무시(이번 실행 동안은 유지)
    }
  }, 200);
}

export function resetLayout(key: LayoutKey) {
  setLayout(key, LAYOUT_DEFAULTS[key], -Infinity, Infinity);
}
