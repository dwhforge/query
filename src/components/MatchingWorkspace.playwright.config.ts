import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "MatchingWorkspace.ui.spec.ts", workers: 1, retries: 0,
  reporter: "list", outputDir: "../../test-results/matching-workspace",
  webServer: { cwd: process.cwd(), command: "npx vite --host 127.0.0.1 --port 4181 --strictPort",
    url: "http://127.0.0.1:4181", reuseExistingServer: false },
  use: { baseURL: "http://127.0.0.1:4181", headless: true,
    launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) } },
});
