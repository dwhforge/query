import { defineConfig } from "@playwright/test";

/** Standalone frontend component gate; deliberately does not launch a host. */
export default defineConfig({
  testDir: ".",
  testMatch: "FindRightDialog.ui.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../../test-results/suggest-right",
  webServer: {
    cwd: process.cwd(),
    command: "npx vite --host 127.0.0.1 --port 4178 --strictPort",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://127.0.0.1:4178",
    headless: true,
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },
});
