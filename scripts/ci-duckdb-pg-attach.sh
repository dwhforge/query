#!/usr/bin/env bash
# Minimal dbt-duckdb → PostgreSQL ATTACH smoke (build, rebuild, fail+retry).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DBT="${ROOT}/dbt-venv/bin/dbt"
DSN="${DWH_PG_DSN:?DWH_PG_DSN required}"
OUT="$(mktemp -d /tmp/dwh-attach-XXXX)"
cleanup() { rm -rf "$OUT"; }
trap cleanup EXIT

mkdir -p "$OUT/models" "$OUT/seeds"
cat > "$OUT/seeds/map_codes.csv" <<'EOF'
from,to
001,online
1,offline
EOF

cat > "$OUT/dbt_project.yml" <<'EOF'
name: 'attach_smoke'
version: '1.0.0'
config-version: 2
profile: 'attach_smoke'
seed-paths: ["seeds"]
model-paths: ["models"]
seeds:
  attach_smoke:
    map_codes:
      +column_types:
        from: varchar
        to: varchar
macro-paths: ["macros"]
models:
  attach_smoke:
    staging:
      +materialized: view
    marts:
      +materialized: table
      +database: pg
      +schema: public
EOF

mkdir -p "$OUT/macros"
cat > "$OUT/macros/generate_schema_name.sql" <<'EOF'
{% macro generate_schema_name(custom_schema_name, node) -%}
  {%- if custom_schema_name is none -%}
    {{ target.schema }}
  {%- else -%}
    {{ custom_schema_name | trim }}
  {%- endif -%}
{%- endmacro %}
EOF

# dbt-duckdb ATTACH: seeds/stg in DuckDB; marts land in Postgres via alias `pg`.
cat > "$OUT/profiles.yml" <<EOF
attach_smoke:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: '$OUT/local.duckdb'
      threads: 1
      attach:
        - path: "${DSN}"
          type: postgres
          alias: pg
          read_only: false
EOF

mkdir -p "$OUT/models/marts"
cat > "$OUT/models/marts/mart_codes.sql" <<'EOF'
{{ config(materialized='table') }}
select "from", "to" from {{ ref('map_codes') }}
EOF

"$DBT" --version | head -5
cd "$OUT"
echo "== seed =="
"$DBT" seed --profiles-dir . --project-dir .
echo "== run =="
"$DBT" run --profiles-dir . --project-dir .
echo "== rebuild =="
"$DBT" run --profiles-dir . --project-dir .
echo "== full-refresh =="
"$DBT" run --full-refresh --profiles-dir . --project-dir .

# Leading-zero check in DuckDB seed + row present in Postgres public.mart_codes
# Prefer dbt-venv Python (has duckdb); system python3 often does not.
PY="${ROOT}/dbt-venv/bin/python3"
if [[ ! -x "$PY" ]]; then
  PY="${ROOT}/dbt-venv/bin/python"
fi
if [[ ! -x "$PY" ]]; then
  echo "dbt-venv python missing — run ./scripts/fetch-dbt-venv.sh" >&2
  exit 1
fi
"$PY" - <<PY
import duckdb, os
dsn = os.environ["DWH_PG_DSN"]
con = duckdb.connect("$OUT/local.duckdb")
rows = con.execute('select "from", "to" from main.map_codes order by 1').fetchall()
print("seed rows", rows)
assert ("001", "online") in rows, rows
assert ("1", "offline") in rows, rows
con.execute(f"ATTACH '{dsn}' AS pg (TYPE postgres)")
pg_rows = con.execute('select "from", "to" from pg.public.mart_codes order by 1').fetchall()
print("pg mart rows", pg_rows)
assert ("001", "online") in pg_rows, pg_rows
print("ACCEPT: leading zeros preserved; mart landed in Postgres")
PY

# Intentional fail then retry
echo "== fail then retry =="
printf '%s\n' "{{ config(materialized='table') }}" "select 1/0 as boom" > "$OUT/models/marts/mart_codes.sql"
set +e
"$DBT" run --select mart_codes --profiles-dir . --project-dir .
fail_rc=$?
set -e
test "$fail_rc" -ne 0
# restore and retry
cat > "$OUT/models/marts/mart_codes.sql" <<'EOF'
{{ config(materialized='table') }}
select "from", "to" from {{ ref('map_codes') }}
EOF
"$DBT" run --select mart_codes --profiles-dir . --project-dir .
echo "ACCEPT: fail+retry recovered"
