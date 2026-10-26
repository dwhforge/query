import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore Rust/Cargo and other heavy trees — watching them hits
      // ENOSPC (inotify limit) and kills Vite → Tauri "Connection refused".
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/dbt-venv/**",
        "**/extensions/**",
        "**/third_party/**",
        "**/.git/**",
      ],
    },
  },
}));
