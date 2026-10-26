#!/usr/bin/env bash
# Pack release binary + libduckdb.so + extensions into a no-install tarball.
# Usage: ./scripts/pack-portable-linux.sh [version]
# Output: dist-portable/dwhforge-query-<ver>-linux-x86_64.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-}"
if [[ -z "$VER" ]]; then
  VER="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/src-tauri/tauri.conf.json" | head -1)"
fi
VER="${VER#v}"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN="$TARGET_DIR/release/dwh-rs-query"
LIB="$ROOT/src-tauri/libduckdb.so"
EXT="$ROOT/src-tauri/extensions"

if [[ ! -x "$BIN" ]]; then
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

NAME="dwhforge-query-${VER}-linux-x86_64"
STAGING="$ROOT/dist-portable/$NAME"
rm -rf "$STAGING"
mkdir -p "$STAGING/extensions"

cp -f "$BIN" "$STAGING/dwh-rs-query"
cp -f "$LIB" "$STAGING/libduckdb.so"
cp -f "$EXT"/*.duckdb_extension "$STAGING/extensions/"
chmod +x "$STAGING/dwh-rs-query"

# Launcher: LD_LIBRARY_PATH so libduckdb.so resolves next to the binary.
cat > "$STAGING/DWHForge-Query" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$DIR/dwh-rs-query" "$@"
EOF
chmod +x "$STAGING/DWHForge-Query"

cat > "$STAGING/README.txt" << EOF
DWHForge Query ${VER} — portable Linux x86_64 (MIT)

Run (no sudo, no install):
  ./DWHForge-Query

Needs system WebKitGTK / GTK (typical on desktop Linux):
  Debian/Ubuntu:  sudo apt install libwebkit2gtk-4.1-0
  RHEL/Fedora:    sudo dnf install webkit2gtk4.1

DuckDB engine + extensions/ are included — no CDN at runtime.
EOF

mkdir -p "$ROOT/dist-portable"
OUT="$ROOT/dist-portable/${NAME}.tar.gz"
tar -C "$ROOT/dist-portable" -czf "$OUT" "$NAME"
echo "Wrote $OUT"
ls -lh "$OUT"
