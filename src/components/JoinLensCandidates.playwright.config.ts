import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "JoinLensCandidates.ui.spec.ts", workers: 1, retries: 0,
  reporter: "list", outputDir: "../../test-results/lens-candidates",
  webServer: { cwd: process.cwd(), command: "npx vite --host 127.0.0.1 --port 4183 --strictPort",
    url: "http://127.0.0.1:4183", reuseExistingServer: false },
  use: { baseURL: "http://127.0.0.1:4183", headless: true,
    viewport: { width: 1500, height: 1000 },
    launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) } },
});
