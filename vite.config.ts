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
  // Test / capture builds share renderer fixture hooks (not production packs).
  // DWH_CAPTURE=1 → website shot workflow; DWH_E2E=1 → Playwright smoke.
  define: {
    "import.meta.env.DWH_E2E": JSON.stringify(
      process.env.DWH_E2E === "1" || process.env.DWH_CAPTURE === "1"
        ? "1"
        : (process.env.DWH_E2E ?? ""),
    ),
  },
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
