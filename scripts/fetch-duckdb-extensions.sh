#!/usr/bin/env bash
# Download DuckDB extensions once, place them next to the app (flat `extensions/`).
# Runtime: bundled DuckDB + LOAD from that folder — no INSTALL, no CDN.
#
# Usage: ./scripts/fetch-duckdb-extensions.sh [duckdb_version]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Must match the *pinned* bundled duckdb-rs ABI (see crates/dwh-engine/Cargo.toml).
# Prefer: cargo run -p dwh-engine --bin dwh-duckdb-info
# Default matches crates/dwh-engine duckdb ~1.20000.0 → DuckDB v2.0.0.
# CDN path uses library_version (v2.0.0), not source_id (d54cbbe3df).
VERSION="${1:-v2.0.0}"
[[ "$VERSION" == v* ]] || VERSION="v${VERSION}"
# If caller passed a bare source_id hash, map known release.
if [[ "$VERSION" == "vd54cbbe3df" || "$VERSION" == "d54cbbe3df" ]]; then
  VERSION="v2.0.0"
fi
echo "Fetching extensions for DuckDB ${VERSION}"

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

# Staging (versioned) + ship folder (flat, next to app)
STAGE="$ROOT/third_party/duckdb-extensions/${VERSION}/${PLATFORM}"
SHIP_ROOT="$ROOT/extensions"
mkdir -p "$STAGE" "$SHIP_ROOT"

BASE="https://extensions.duckdb.org/${VERSION}/${PLATFORM}"
EXT_FILES=(postgres_scanner httpfs aws)

for name in "${EXT_FILES[@]}"; do
  gz="$STAGE/${name}.duckdb_extension.gz"
  out="$STAGE/${name}.duckdb_extension"
  url="${BASE}/${name}.duckdb_extension.gz"
  echo "Fetching $url"
  curl -fsSL "$url" -o "$gz"
  gzip -df "$gz"
  cp -f "$out" "$SHIP_ROOT/"
  echo "  -> $SHIP_ROOT/${name}.duckdb_extension"
done

# Alias used by some loaders (copy on Windows — no symlink privilege needed)
alias_postgres() {
  local dir="$1"
  local src="$dir/postgres_scanner.duckdb_extension"
  local dst="$dir/postgres.duckdb_extension"
  if [[ "$OS_NAME" == "windows" ]]; then
    cp -f "$src" "$dst"
  else
    ln -sfn postgres_scanner.duckdb_extension "$dst"
  fi
}
alias_postgres "$SHIP_ROOT"

cat > "$SHIP_ROOT/README.md" <<'EOF'
# App-sidecar DuckDB extensions

These files ship **next to the application** (`extensions/`).

Bundled DuckDB loads them with `LOAD '…/extensions/<file>'` — **no INSTALL**, no network.

Required:
- `postgres_scanner.duckdb_extension` — Postgres
- `httpfs.duckdb_extension` — s3:// and https://
- `aws.duckdb_extension` — optional S3 credentials helper

Refresh: `../scripts/fetch-duckdb-extensions.sh`
EOF

echo
echo "Ship layout (no install at runtime):"
echo "  $SHIP_ROOT/"
ls -lah "$SHIP_ROOT"

# If cargo already downloaded the prebuilt core lib, place it next to binaries.
if [[ -x "$ROOT/scripts/sync-duckdb-lib.sh" ]]; then
  "$ROOT/scripts/sync-duckdb-lib.sh" || true
fi
