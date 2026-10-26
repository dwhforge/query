#!/usr/bin/env bash
# Create a local Python venv with dbt Core 1.x for offline `dbt parse` on Export.
# Runtime: app prefers src-tauri/dbt-venv/bin/dbt, else `dbt` on PATH.
#
# Usage: ./scripts/fetch-dbt-venv.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/src-tauri/dbt-venv"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

echo "Creating venv at $VENV"
python3 -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install --upgrade pip
# duckdb + postgres adapters — match Project.target_dialect in profiles.yml
python -m pip install \
  'dbt-core>=1.7,<2' \
  'dbt-duckdb>=1.7,<2' \
  'dbt-postgres>=1.7,<2'

DBT="$VENV/bin/dbt"
if [[ ! -x "$DBT" ]]; then
  echo "dbt binary missing after install: $DBT" >&2
  exit 1
fi

echo "dbt ready: $("$DBT" --version | head -n 3)"
echo "  -> $DBT"
echo "Export in the app will use this for offline \`dbt parse\` (no warehouse)."
