// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 판(flavor): 개발판(dev, 지금 쓰던 그대로)과 배포판(release, 공개 베타).
// 배포판은 `vite build --mode release`(.env.release의 VITE_FLAVOR=release)로 만든다.
// 배포판에는 계정 여러 개(추가·전환·자동 전환)가 없다 — 약관 때문(2026-11-14 수익화 기획 4장 5).

export type Flavor = "dev" | "release";

export function flavor(): Flavor {
  return import.meta.env.VITE_FLAVOR === "release" ? "release" : "dev";
}

/** 계정 여러 개(추가·전환·한도 때 자동 전환) — 개발판만 */
export function multiAccount(): boolean {
  return flavor() === "dev";
}
