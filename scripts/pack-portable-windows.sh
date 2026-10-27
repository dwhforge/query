#!/usr/bin/env bash
# Pack release binary + duckdb.dll + extensions into a no-install zip.
# Usage: ./scripts/pack-portable-windows.sh [version]
# Output: dist-portable/dwhforge-query-<ver>-windows-x86_64.zip
# Runs on Git Bash / MSYS (GitHub windows-latest) or WSL with a Windows build tree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-}"
if [[ -z "$VER" ]]; then
  VER="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/src-tauri/tauri.conf.json" | head -1)"
fi
VER="${VER#v}"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN="$TARGET_DIR/release/dwh-rs-query.exe"
LIB="$ROOT/src-tauri/duckdb.dll"
EXT="$ROOT/src-tauri/extensions"

if [[ ! -f "$BIN" ]]; then
  echo "Missing $BIN — run: cargo build -p dwh-rs-query --release (or npm run tauri build)" >&2
  exit 1
fi
if [[ ! -f "$LIB" ]]; then
  echo "Missing $LIB — run: ./scripts/sync-duckdb-lib.sh" >&2
  exit 1
fi
if [[ ! -f "$EXT/postgres_scanner.duckdb_extension" ]]; then
  echo "Missing extensions — run: ./scripts/fetch-duckdb-extensions.sh" >&2
  exit 1
fi

FIXTURES="$ROOT/fixtures"
if [[ ! -f "$FIXTURES/sample.csv" ]]; then
  echo "Missing $FIXTURES — demo CSVs required for portable pack" >&2
  exit 1
fi

NAME="dwhforge-query-${VER}-windows-x86_64"
STAGING="$ROOT/dist-portable/$NAME"
rm -rf "$STAGING"
mkdir -p "$STAGING/extensions" "$STAGING/fixtures"

cp -f "$BIN" "$STAGING/DWHForge-Query.exe"
cp -f "$LIB" "$STAGING/duckdb.dll"
cp -f "$EXT"/*.duckdb_extension "$STAGING/extensions/"
cp -f "$FIXTURES"/*.csv "$STAGING/fixtures/"

cat > "$STAGING/README.txt" << EOF
DWHForge Query ${VER} — portable Windows x86_64 (MIT)

Run (no installer):
  DWHForge-Query.exe

Keep fixtures/ next to the exe (demos / samples).
Needs Microsoft Edge WebView2 Runtime (usually already on Windows 10/11).
DuckDB engine + extensions/ are included — no CDN at runtime.
EOF

mkdir -p "$ROOT/dist-portable"
OUT="$ROOT/dist-portable/${NAME}.zip"
rm -f "$OUT"

# Prefer PowerShell Compress-Archive (windows-latest); fall back to zip if present.
if command -v powershell.exe >/dev/null 2>&1; then
  # Convert Git Bash path to Windows path for PowerShell
  STAGING_WIN="$(cygpath -w "$STAGING" 2>/dev/null || echo "$STAGING")"
  OUT_WIN="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
  powershell.exe -NoProfile -Command \
    "Compress-Archive -Path '$STAGING_WIN' -DestinationPath '$OUT_WIN' -Force"
elif command -v zip >/dev/null 2>&1; then
  (cd "$ROOT/dist-portable" && zip -r "${NAME}.zip" "$NAME")
else
  python3 - << PY
import shutil
shutil.make_archive(r"$ROOT/dist-portable/$NAME", "zip", r"$ROOT/dist-portable", "$NAME")
PY
fi

echo "Wrote $OUT"
ls -lh "$OUT"
