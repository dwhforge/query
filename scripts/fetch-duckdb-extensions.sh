#!/usr/bin/env bash
# Download DuckDB extensions once, place them next to the app (flat `extensions/`).
# Runtime: bundled DuckDB + LOAD from that folder — no INSTALL, no CDN.
#
# Usage: ./scripts/fetch-duckdb-extensions.sh [duckdb_version]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Bundled duckdb-rs reports e.g. v2.0.0-dev*; CDN artifacts use the stable tag v2.0.0.
VERSION="${1:-v2.0.0}"
[[ "$VERSION" == v* ]] || VERSION="v${VERSION}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux) OS_NAME=linux ;;
  Darwin) OS_NAME=osx ;;
  MINGW*|MSYS*|CYGWIN*) OS_NAME=windows ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH_NAME=amd64 ;;
  aarch64|arm64) ARCH_NAME=arm64 ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac
PLATFORM="${OS_NAME}_${ARCH_NAME}"

# Staging (versioned) + ship folders (flat, next to app)
STAGE="$ROOT/third_party/duckdb-extensions/${VERSION}/${PLATFORM}"
SHIP_TAURI="$ROOT/src-tauri/extensions"
SHIP_ROOT="$ROOT/extensions"
mkdir -p "$STAGE" "$SHIP_TAURI" "$SHIP_ROOT"

BASE="https://extensions.duckdb.org/${VERSION}/${PLATFORM}"
EXT_FILES=(postgres_scanner httpfs aws)

for name in "${EXT_FILES[@]}"; do
  gz="$STAGE/${name}.duckdb_extension.gz"
  out="$STAGE/${name}.duckdb_extension"
  url="${BASE}/${name}.duckdb_extension.gz"
  echo "Fetching $url"
  curl -fsSL "$url" -o "$gz"
  gzip -df "$gz"
  cp -f "$out" "$SHIP_TAURI/"
  cp -f "$out" "$SHIP_ROOT/"
  echo "  -> $SHIP_TAURI/${name}.duckdb_extension"
done

# Alias used by some loaders
ln -sfn postgres_scanner.duckdb_extension "$SHIP_TAURI/postgres.duckdb_extension"
ln -sfn postgres_scanner.duckdb_extension "$SHIP_ROOT/postgres.duckdb_extension"

cat > "$SHIP_TAURI/README.md" <<'EOF'
# App-sidecar DuckDB extensions

These files ship **next to the application** (Tauri bundle resources → `extensions/`).

Bundled DuckDB (in-process) loads them with `LOAD '/…/extensions/<file>'` — **no INSTALL**, no network.

Required:
- `postgres_scanner.duckdb_extension` — Postgres
- `httpfs.duckdb_extension` — s3:// and https://
- `aws.duckdb_extension` — optional S3 credentials helper

Refresh: `../../scripts/fetch-duckdb-extensions.sh`
EOF

echo
echo "Ship layout (no install at runtime):"
echo "  $SHIP_TAURI/"
echo "  $SHIP_ROOT/   (also used when binary is run from repo with ./extensions)"
ls -lah "$SHIP_TAURI"
