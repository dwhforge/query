#!/usr/bin/env bash
# ADR-0029: regenerated bindings must match committed tree, including untracked files.
# git diff alone misses untracked additions — compare against a clean temp export.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GEN_DIR="src/types/generated"
if [[ ! -d "$GEN_DIR" ]]; then
  echo "missing $GEN_DIR" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dwh-ts-types.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Snapshot committed+working tree inventory (tracked and untracked under GEN_DIR).
manifest_before="$TMP/before.txt"
(
  cd "$GEN_DIR"
  find . -type f | sed 's|^\./||' | sort
) >"$manifest_before"

# Export into an isolated copy of the generated tree.
cp -a "$GEN_DIR" "$TMP/generated"
# export-ts writes into src/types/generated — run from a work tree shadow via symlink swap.
SHADOW="$TMP/shadow"
mkdir -p "$SHADOW/src/types" "$SHADOW/scripts" "$SHADOW/crates"
# Re-run exporters against real crates but redirect output by temporarily swapping GEN_DIR.
BACKUP="$TMP/backup-generated"
mv "$GEN_DIR" "$BACKUP"
mkdir -p "$GEN_DIR"

set +e
cargo run -q -p dwh-pipeline --bin export-ts
ec1=$?
cargo run -q -p dwh-host --bin export-ts-host
ec2=$?
set -e

if [[ $ec1 -ne 0 || $ec2 -ne 0 ]]; then
  rm -rf "$GEN_DIR"
  mv "$BACKUP" "$GEN_DIR"
  echo "export-ts failed" >&2
  exit 1
fi

manifest_after="$TMP/after.txt"
(
  cd "$GEN_DIR"
  find . -type f | sed 's|^\./||' | sort
) >"$manifest_after"

# Diff file list (catches adds/removes/renames).
if ! diff -u "$manifest_before" "$manifest_after" >"$TMP/manifest.diff"; then
  echo "Generated type inventory changed:" >&2
  cat "$TMP/manifest.diff" >&2
  # Restore original tree for the developer.
  rm -rf "$GEN_DIR"
  mv "$BACKUP" "$GEN_DIR"
  exit 1
fi

# Diff contents.
if ! diff -ruN "$BACKUP" "$GEN_DIR" >"$TMP/content.diff"; then
  echo "Generated type contents drifted:" >&2
  cat "$TMP/content.diff" >&2
  rm -rf "$GEN_DIR"
  mv "$BACKUP" "$GEN_DIR"
  exit 1
fi

# Success — keep regenerated tree (identical) or restore; restore is safer for mtimes.
rm -rf "$GEN_DIR"
mv "$BACKUP" "$GEN_DIR"
echo "OK: generated types fresh ($GEN_DIR)"
