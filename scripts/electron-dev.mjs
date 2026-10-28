#!/usr/bin/env node
/** Start Vite + Electron against release dwh-host. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
  cwd: root,
  env: { ...process.env, DWH_ELECTRON: "1" },
  stdio: "inherit",
  shell: true,
});

await new Promise((r) => setTimeout(r, 1500));

const electronBin = path.join(root, "node_modules", ".bin", "electron");
const elec = spawn(
  electronBin,
  [".", "--no-sandbox", "--disable-gpu-sandbox"],
  {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://localhost:1420",
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
