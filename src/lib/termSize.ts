// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 터미널 크기를 CLI에 보낼지: 숨겨졌거나 비정상적으로 작은 크기는 보내지 않는다(좁게 그려진 채 잠드는 것 방지).
export const MIN_COLS = 20;
export const MIN_ROWS = 5;

/** 컨테이너가 화면에 보이고 최소한의 크기가 있는지(px) */
export function sizeUsable(w: number, h: number): boolean {
  return w >= 120 && h >= 60;
}

/** 맞춘 결과(칸·줄)가 쓸 만한지 */
export function dimsUsable(cols: number, rows: number): boolean {
  return cols >= MIN_COLS && rows >= MIN_ROWS;
}
