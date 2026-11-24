// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 프론트 단위 테스트: .svelte.ts(runes) 모듈도 컴파일되도록 svelte 플러그인 사용
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
    conditions: ["browser"],
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
