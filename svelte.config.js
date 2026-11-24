// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Tauri는 Node 서버가 없으므로 adapter-static + index.html fallback(SPA 모드) 사용
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
  },
};

export default config;
