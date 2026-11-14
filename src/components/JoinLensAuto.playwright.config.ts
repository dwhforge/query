import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "JoinLensAuto.ui.spec.ts", workers: 1, retries: 0,
  reporter: "list", outputDir: "../../test-results/find-matches",
  webServer: {
    cwd: process.cwd(), command: "npx vite --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179", reuseExistingServer: false,
  },
  use: { baseURL: "http://127.0.0.1:4179", headless: true,
    launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) },
  },
});
