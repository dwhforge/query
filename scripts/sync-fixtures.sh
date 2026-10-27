#!/usr/bin/env bash
# Copy demo CSVs into src-tauri/fixtures for Tauri bundle resources.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/fixtures"
DST="$ROOT/src-tauri/fixtures"

if [[ ! -f "$SRC/sample.csv" ]]; then
  echo "Missing $SRC/sample.csv" >&2
  exit 1
fi

mkdir -p "$DST"
cp -f "$SRC"/*.csv "$DST/"
echo "Synced fixtures -> $DST"
ls -la "$DST"
