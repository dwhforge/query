import { defineConfig } from "@playwright/test";

/**
 * Electron mapping-create smoke (experimental Playwright Electron API).
 * Run: `npm run test:e2e:electron`
 */
export default defineConfig({
  testDir: "e2e/electron",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
