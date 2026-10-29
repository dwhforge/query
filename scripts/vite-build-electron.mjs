#!/usr/bin/env node
/** Cross-platform `DWH_ELECTRON_BUILD=1 vite build` (Windows CI cannot use Unix env=). */
import { spawnSync } from "node:child_process";

const env = { ...process.env, DWH_ELECTRON_BUILD: "1" };
const r = spawnSync("npx", ["vite", "build"], {
  stdio: "inherit",
  env,
  shell: true,
});
process.exit(r.status === null ? 1 : r.status);
