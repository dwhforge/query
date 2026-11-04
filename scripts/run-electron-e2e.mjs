#!/usr/bin/env node
/**
 * Build host + UI if needed, then run Playwright Electron mapping-create smoke.
 * Playwright's Electron API is experimental — pin @playwright/test carefully.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostName = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
const hostBin = path.join(root, "target/release", hostName);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32" || cmd === "npm" || cmd === "npx",
    ...opts,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!fs.existsSync(hostBin)) {
  console.log("building dwh-host (release)…");
  run("cargo", ["build", "-p", "dwh-host", "--release"]);
}

const indexHtml = path.join(root, "dist/index.html");
if (process.env.DWH_E2E_SKIP_UI_BUILD === "1" && fs.existsSync(indexHtml)) {
  console.log("skipping UI build (DWH_E2E_SKIP_UI_BUILD=1)");
} else {
  // Rebuild UI so App e2e hooks / wizard changes are picked up.
  console.log("building UI (dist/)…");
  run("npm", ["run", "build"], {
    env: { ...process.env, DWH_ELECTRON_BUILD: "1" },
  });
}

const pwArgs = ["playwright", "test", "-c", "playwright.config.ts"];
if (process.argv.includes("--headed")) pwArgs.push("--headed");
if (process.argv.includes("--debug")) pwArgs.push("--debug");

run("npx", pwArgs, {
  env: {
    ...process.env,
    // Linux CI / headless agents.
    ELECTRON_DISABLE_SANDBOX: "1",
  },
});
