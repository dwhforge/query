# KeyMap example labs

Readable business fixtures for Help demos (not `scripts/stress/` synthetic load).

## Generate

```bash
python scripts/examples/generate_all.py
# writes fixtures/examples/{crosswalk,dual,codes,hop}/
```

## Load Postgres lab

Needs local Postgres:

| | |
|--|--|
| DSN | `postgresql://postgres:postgres@localhost:5432/dwh_tests` |
| Schema | `keymap_demo` |
| App connection id | `conn_postgres` |

```bash
# once: create DB if missing
PGPASSWORD=postgres psql -h localhost -U postgres -c 'CREATE DATABASE dwh_tests;'
export DWH_PG_DSN='postgresql://postgres:postgres@localhost:5432/dwh_tests'  # optional
python scripts/examples/load_postgres.py
```

Uses DuckDB CLI on `PATH` (or `pip install duckdb`) with the postgres extension.

## Domains

| Folder | Topology | Story |
|--------|----------|--------|
| `crosswalk/` | B2 | Grocery POS sku ↔ WMS item |
| `dual/` | B3 | Restaurant brands vs AP vendors → `dim_party` (edit master + two maps) |
| `codes/` | B4 | Channel / region synonyms |
| `hop/` | B5 | Store → region → country |

See [docs/keymap-workflows.md](../../docs/keymap-workflows.md) Patterns.
