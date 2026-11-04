#!/usr/bin/env node
/**
 * Build a capture-mode UI + host, then shoot website feature PNGs.
 *
 * Capture mode (`DWH_CAPTURE=1`) enables the same renderer fixture hooks as
 * `DWH_E2E=1` (open project without native dialogs) but is a separate workflow
 * from Playwright smoke tests — use this when refreshing marketing shots.
 *
 *   npm run capture:website
 *   npm run capture:website -- --only join-lens
 *   DWH_CAPTURE_SKIP_UI_BUILD=1 npm run capture:website   # reuse dist/
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import captureConfig from "../website/capture.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32" || cmd === "npm" || cmd === "npx",
    ...opts,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const hostName = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
const hostBin = path.join(root, "target/release", hostName);

if (process.env.DWH_CAPTURE_SKIP_HOST_BUILD === "1") {
  console.log("skipping host build (DWH_CAPTURE_SKIP_HOST_BUILD=1)");
} else {
  console.log("building dwh-host (release)…");
  run("cargo", ["build", "-p", "dwh-host", "--release"]);
}
if (!fs.existsSync(hostBin)) {
  console.error(`dwh-host missing at ${hostBin}`);
  process.exit(1);
}
console.log(`capture host binary: ${hostBin}`);

const indexHtml = path.join(root, "dist/index.html");
if (
  process.env.DWH_CAPTURE_SKIP_UI_BUILD === "1" &&
  fs.existsSync(indexHtml)
) {
  console.log("skipping UI build (DWH_CAPTURE_SKIP_UI_BUILD=1)");
} else {
  console.log("building UI (dist/) with DWH_CAPTURE=1…");
  run("npm", ["run", "build"], {
    env: {
      ...process.env,
      DWH_ELECTRON_BUILD: "1",
      DWH_CAPTURE: "1",
      // Fixture open hooks share the E2E gate in the renderer.
      DWH_E2E: "1",
    },
  });
}

const enabled = captureConfig.shots.filter((s) => s.enabled).map((s) => s.id);
const disabled = captureConfig.shots.filter((s) => !s.enabled);
console.log(`capture shots (enabled): ${enabled.join(", ") || "(none)"}`);
for (const s of disabled) {
  console.log(`  skip ${s.id}: ${s.note || "disabled in website/capture.config.mjs"}`);
}

const forward = process.argv.slice(2);
run("node", ["scripts/capture-website-shots.mjs", ...forward], {
  env: {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: "1",
    DWH_E2E_SKIP_HOST_BUILD: "1",
    DWH_CAPTURE: "1",
  },
});
