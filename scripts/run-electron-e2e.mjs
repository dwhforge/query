#!/usr/bin/env node
/**
 * Always rebuild host + E2E UI (DWH_E2E=1), then run Playwright Electron smoke.
 * Playwright's Electron API is experimental — pin @playwright/test carefully.
 *
 * Opt-outs (local only):
 *   DWH_E2E_SKIP_HOST_BUILD=1 — skip cargo (stale host risk)
 *   DWH_E2E_SKIP_UI_BUILD=1   — reuse dist/ if present
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostName = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
const hostBin = path.join(root, "target/release", hostName);
const portableHost = path.join(root, hostName);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32" || cmd === "npm" || cmd === "npx",
    ...opts,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.env.DWH_E2E_SKIP_HOST_BUILD === "1") {
  console.log("skipping host build (DWH_E2E_SKIP_HOST_BUILD=1)");
} else {
  console.log("building dwh-host (release)…");
  run("cargo", ["build", "-p", "dwh-host", "--release"]);
}

const chosen = fs.existsSync(portableHost)
  ? { path: portableHost, via: "portable-beside-app" }
  : { path: hostBin, via: "target/release" };
console.log(`e2e host binary: ${chosen.path} (${chosen.via})`);
if (!fs.existsSync(chosen.path)) {
  console.error(`dwh-host missing at ${chosen.path}`);
  process.exit(1);
}
if (chosen.via === "portable-beside-app") {
  console.warn(
    "WARNING: portable dwh-host beside the app takes precedence over target/release.",
  );
}

const indexHtml = path.join(root, "dist/index.html");
if (process.env.DWH_E2E_SKIP_UI_BUILD === "1" && fs.existsSync(indexHtml)) {
  console.log("skipping UI build (DWH_E2E_SKIP_UI_BUILD=1)");
} else {
  // E2E UI: electron asset base + test hooks (not the same as a production pack).
  console.log("building UI (dist/) with DWH_E2E=1…");
  run("npm", ["run", "build"], {
    env: {
      ...process.env,
      DWH_ELECTRON_BUILD: "1",
      DWH_E2E: "1",
    },
  });
}

const pwArgs = ["playwright", "test", "-c", "playwright.config.ts"];
for (const a of process.argv.slice(2)) {
  if (a === "--headed" || a === "--debug") pwArgs.push(a);
  else if (a.startsWith("--grep") || a === "-g") {
    /* forwarded below */
  }
}
// Forward remaining args (e.g. --grep "cancel") so scenarios can run alone.
const forward = process.argv.slice(2).filter(
  (a) => a !== "--headed" && a !== "--debug",
);
pwArgs.push(...forward);

const pwEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: "1",
  // Script already rebuilt host — workers only verify path.
  DWH_E2E_SKIP_HOST_BUILD: "1",
};
delete pwEnv.ELECTRON_RUN_AS_NODE;
delete pwEnv.NODE_OPTIONS;

run("npx", pwArgs, { env: pwEnv });
