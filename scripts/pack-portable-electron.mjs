#!/usr/bin/env node
/**
 * Portable Linux/Windows folder: Electron + dwh-host + DuckDB + extensions + fixtures.
 * Output: dist-portable/dwhforge-query-<ver>-electron-<os>-x64/
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ver =
  process.argv[2]?.replace(/^v/, "") ||
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const platform = process.platform === "win32" ? "windows" : "linux";
const name = `dwhforge-query-${ver}-electron-${platform}-x64`;
const staging = path.join(root, "dist-portable", name);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const hostName = platform === "windows" ? "dwh-host.exe" : "dwh-host";
const hostSrc = path.join(root, "target", "release", hostName);
if (!fs.existsSync(hostSrc)) {
  console.error(`Missing ${hostSrc}`);
  process.exit(1);
}

const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) {
  console.error("Missing dist/ — run npm run build");
  process.exit(1);
}

// Copy app sources needed at runtime
for (const rel of ["dist", "electron", "package.json"]) {
  const src = path.join(root, rel);
  const dest = path.join(staging, rel);
  fs.cpSync(src, dest, { recursive: true });
}

// Host + native libs
fs.copyFileSync(hostSrc, path.join(staging, hostName));

const libCandidates = [
  path.join(root, "target", "release", "libduckdb.so"),
  path.join(root, "target", "release", "duckdb.dll"),
];
for (const lib of libCandidates) {
  if (fs.existsSync(lib)) {
    fs.copyFileSync(lib, path.join(staging, path.basename(lib)));
  }
}

fs.cpSync(path.join(root, "extensions"), path.join(staging, "extensions"), {
  recursive: true,
});
fs.cpSync(path.join(root, "fixtures"), path.join(staging, "fixtures"), {
  recursive: true,
});

// Install production node deps + electron into staging
spawnSync("npm", ["install", "--omit=dev", "electron@37.2.0"], {
  cwd: staging,
  stdio: "inherit",
  shell: true,
});

const readme = `DWHForge Query ${ver} — portable Electron (${platform})

Run:
  Linux:   ./DWHForge-Query
  Windows: DWHForge-Query.cmd

No system WebKitGTK / dnf required (Chromium bundled via Electron).
DuckDB + extensions/ are included.
`;
fs.writeFileSync(path.join(staging, "README.txt"), readme);

if (platform === "linux") {
  const launcher = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$DIR\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DWH_EXTENSIONS_DIR="$DIR/extensions"
export DWH_FIXTURES_DIR="$DIR/fixtures"
export ELECTRON_DISABLE_SANDBOX=1
cd "$DIR"
exec "$DIR/node_modules/.bin/electron" "$DIR" --no-sandbox --disable-gpu-sandbox
`;
  fs.writeFileSync(path.join(staging, "DWHForge-Query"), launcher, { mode: 0o755 });
} else {
  const launcher = `@echo off
set DIR=%~dp0
set PATH=%DIR%;%PATH%
set DWH_EXTENSIONS_DIR=%DIR%extensions
set DWH_FIXTURES_DIR=%DIR%fixtures
cd /d "%DIR%"
"%DIR%node_modules\\electron\\dist\\electron.exe" "%DIR%"
`;
  fs.writeFileSync(path.join(staging, "DWHForge-Query.cmd"), launcher);
}

// Patch main to find resources beside app when portable
console.log(`Wrote ${staging}`);
console.log("Pack tarball yourself if needed: tar -C dist-portable -czf …");
