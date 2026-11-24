// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { it, expect } from "vitest";
import { shouldStick } from "./stickyScroll";

it("바닥 40px 이내면 따라간다", () => {
  expect(shouldStick(560, 1000, 400)).toBe(true); // 바닥과 40px
  expect(shouldStick(600, 1000, 400)).toBe(true); // 정확히 바닥
  expect(shouldStick(500, 1000, 400)).toBe(false); // 100px 위
  expect(shouldStick(0, 300, 400)).toBe(true); // 스크롤이 없을 만큼 짧음
});

import { nextStick } from "./stickyScroll";
it("내용이 갑자기 많이 늘어도(위치는 그대로) 따라가기를 끄지 않는다", () => {
  // 바닥(600)에 있었는데 내용이 1000 → 3000으로 커져 바닥과 멀어짐: 사용자가 올린 게 아님
  expect(nextStick(true, 600, 600, 3000, 400)).toBe(true);
});
it("사용자가 위로 올리면 끄고, 다시 바닥 근처로 내리면 켠다", () => {
  expect(nextStick(true, 600, 300, 1000, 400)).toBe(false);
  expect(nextStick(false, 300, 350, 1000, 400)).toBe(false); // 아직 위
  expect(nextStick(false, 350, 580, 1000, 400)).toBe(true); // 바닥 40px 안
});
it("꺼져 있을 때 내용이 늘어도 그대로 꺼져 있다", () => {
  expect(nextStick(false, 300, 300, 3000, 400)).toBe(false);
});
