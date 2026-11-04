#!/usr/bin/env bash
# Regenerate TypeScript bindings from Rust (ADR-0029).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
cargo run -q -p dwh-pipeline --bin export-ts
cargo run -q -p dwh-host --bin export-ts-host
echo "OK: src/types/generated/"
