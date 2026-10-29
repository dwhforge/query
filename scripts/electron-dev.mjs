#!/usr/bin/env node
/** Start Vite + Electron against release dwh-host. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_URL = "http://localhost:1420";

const vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
  cwd: root,
  env: { ...process.env, DWH_ELECTRON: "1" },
  stdio: "inherit",
  shell: true,
});

/** Wait until Vite answers — fixed sleep races → blank Electron window. */
async function waitForVite(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

try {
  await waitForVite(DEV_URL);
} catch (e) {
  console.error(String(e));
  vite.kill();
  process.exit(1);
}

const electronBin = path.join(root, "node_modules", ".bin", "electron");
// --disable-gpu: blank white window on some Linux GPU stacks (viz init error).
const elec = spawn(
  electronBin,
  [".", "--no-sandbox", "--disable-gpu-sandbox", "--disable-gpu"],
  {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: DEV_URL,
      ELECTRON_DISABLE_SANDBOX: "1",
    },
    stdio: "inherit",
  },
);

const shutdown = () => {
  vite.kill();
  elec.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

elec.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
