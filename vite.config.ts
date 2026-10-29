import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.VITE_DEV_HOST;
const electron = process.env.DWH_ELECTRON === "1";

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs for Electron file:// / asar load.
  base: electron || process.env.DWH_ELECTRON_BUILD === "1" ? "./" : "/",
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
      ignored: [
        "**/electron/**",
        "**/target/**",
        "**/dbt-venv/**",
        "**/extensions/**",
        "**/third_party/**",
        "**/.git/**",
      ],
    },
  },
}));
