#!/usr/bin/env bash
# Copy prebuilt libduckdb next to Cargo binaries (Electron dwh-host sidecar).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

shopt -s nullglob
candidates=(
  "$TARGET_DIR"/duckdb-download/*/v2.0.0/libduckdb.so
  "$TARGET_DIR"/duckdb-download/*/v2.0.0/libduckdb.dylib
  "$TARGET_DIR"/duckdb-download/*/v2.0.0/duckdb.dll
)
if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "No downloaded libduckdb found under $TARGET_DIR/duckdb-download/" >&2
  echo "Build once: cargo build -p dwh-engine" >&2
  exit 1
fi
SRC="${candidates[0]}"
BASE="$(basename "$SRC")"
echo "Using $SRC"

for dest in \
  "$TARGET_DIR/debug" \
  "$TARGET_DIR/release"; do
  mkdir -p "$dest"
  cp -f "$SRC" "$dest/$BASE"
  echo "  -> $dest/$BASE"
done
