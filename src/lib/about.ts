// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 정보 화면에 보일 것: 저작권·라이선스·저장소·피드백·후원, 그리고 앱이 밖으로 연결하는 기능 목록(사용자가 알 수 있게).
export const ABOUT = {
  name: "AITermHub",
  copyright: "Copyright (c) 2026 Backhacandy",
  license: "AGPL-3.0-or-later",
  repo: "https://github.com/Backhacandy/AITermHub",
  issues: "https://github.com/Backhacandy/AITermHub/issues/new/choose",
  /** 만든 사람 표시 — NOTICE의 추가 조건(AGPL 7조 b항)으로, 고친 버전도 정보 화면에서 지우지 않고 유지해야 한다 */
  credit: "Made by Backhacandy",
  /** 프로젝트 소식 */
  instagram: "https://www.instagram.com/aitermhub/",
  /** 만든 사람 */
  authorInstagram: "https://www.instagram.com/i_dh0101/",
  /** GitHub Sponsors 승인 뒤 채운다 */
  sponsor: "",
  marker: "aith-bk26-68a3b8a0b4ae",
};

export const showSponsor = (a: { sponsor: string }) => a.sponsor.trim().length > 0;

/** 앱이 이 PC 밖으로 연결하는 기능(사용 통계는 보내지 않음). Claude·Codex CLI 자체의 통신은 각 CLI가 한다. */
export const EXTERNAL: { name: string; where: string; when: string }[] = [
  { name: "업데이트 확인", where: "GitHub 릴리스(github.com/Backhacandy/AITermHub)", when: "배포판에서 시작할 때와 하루 한 번" },
  { name: "모바일 원격", where: "Claude 원격 제어(claude.ai)", when: "설정에서 켜고 폴더를 연결했을 때만" },
  { name: "알림(ntfy)", where: "설정에 적은 ntfy 주소", when: "설정에서 켰을 때만" },
  { name: "GitHub 잔디·포트폴리오·PR", where: "GitHub(내 저장소)", when: "설정에서 켜고 폴더를 적었을 때만" },
  { name: "Claude·Codex CLI 자동 업데이트", where: "npm·Claude 업데이트 서버", when: "설정에서 켜 둔 동안 하루 한 번(일하는 중이 아닐 때)" },
];
