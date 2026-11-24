// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
// @ts-expect-error @types/node 없이 쓰는 process
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// 오픈소스(AGPL)로 공개하므로 배포 빌드 난독화는 하지 않는다(소스가 공개돼 감출 것이 없고, 문자열 풀기로 느려지기만 한다)
export default defineConfig(() => ({
  plugins: [sveltekit()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
