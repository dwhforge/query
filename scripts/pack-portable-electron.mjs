#!/usr/bin/env node
/**
 * Portable Linux/Windows folder: Electron + dwh-host + DuckDB + extensions + fixtures.
 * Output: dist-portable/dwhforge-query-<ver>-electron-<os>-x64/
 *
 * Electron is **copied** from the build tree's node_modules (already downloaded by
 * `npm install`). Do not re-npm-install into staging — that skips the binary when
 * electron is only a devDependency / omit=dev.
 */
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

const electronPkg = path.join(root, "node_modules", "electron");
const electronBinName = platform === "windows" ? "electron.exe" : "electron";
const electronBinSrc = path.join(electronPkg, "dist", electronBinName);
if (!fs.existsSync(electronBinSrc)) {
  console.error(
    `Missing Electron binary at ${electronBinSrc}\n` +
      `Run: npm install   (electron must download its dist/)`,
  );
  process.exit(1);
}

// Minimal app payload (UI is prebuilt; no need for react/etc in node_modules)
for (const rel of ["dist", "electron", "package.json"]) {
  fs.cpSync(path.join(root, rel), path.join(staging, rel), { recursive: true });
}

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

// Bundle Electron runtime (binary + libs under dist/)
const electronDest = path.join(staging, "node_modules", "electron");
fs.mkdirSync(path.dirname(electronDest), { recursive: true });
fs.cpSync(electronPkg, electronDest, { recursive: true });

const electronBinDest = path.join(electronDest, "dist", electronBinName);
if (!fs.existsSync(electronBinDest)) {
  console.error(`Pack failed: electron binary missing after copy: ${electronBinDest}`);
  process.exit(1);
}
try {
  fs.chmodSync(electronBinDest, 0o755);
} catch {
  /* windows */
}

const readme = `DWHForge Query ${ver} — portable Electron (${platform})

Run:
  Linux:   ./DWHForge-Query
  Windows: DWHForge-Query.cmd

No system WebKitGTK / dnf / Node.js required (Chromium bundled).
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
ELECTRON_BIN="$DIR/node_modules/electron/dist/electron"
if [[ ! -x "\$ELECTRON_BIN" ]]; then
  echo "Missing Electron binary: \$ELECTRON_BIN" >&2
  exit 1
fi
exec "\$ELECTRON_BIN" "\$DIR" --no-sandbox --disable-gpu-sandbox
`;
  fs.writeFileSync(path.join(staging, "DWHForge-Query"), launcher, {
    mode: 0o755,
  });
} else {
  const launcher = `@echo off
set DIR=%~dp0
set PATH=%DIR%;%PATH%
set DWH_EXTENSIONS_DIR=%DIR%extensions
set DWH_FIXTURES_DIR=%DIR%fixtures
cd /d "%DIR%"
"%DIR%node_modules\\electron\\dist\\electron.exe" "%DIR%" --no-sandbox
`;
  fs.writeFileSync(path.join(staging, "DWHForge-Query.cmd"), launcher);
}

console.log(`Wrote ${staging}`);
console.log(`Electron: ${electronBinDest}`);
console.log("Pack: tar -C dist-portable -czf <name>.tar.gz <dirname>");
