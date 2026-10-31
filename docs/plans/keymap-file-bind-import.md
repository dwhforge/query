# Plan (future): KeyMap file bind / import

**Status:** Future — after [ADR-0022](../adr/0022-keymap-postgres-live-bind.md) Postgres live path ships.  
**Not** an Accepted ADR yet.

## Intent

Allow mapping dictionaries that today live as **parquet or CSV** (e.g. stress deliveries, partner drops) to participate in KeyMap without pretending files support row-level upsert.

## Options (when we pick this up)

1. **Read-only bind** — `KeyMapStorage::File { path, format }`; wizard picks path + From/To (+ display attrs); preview via DuckDB `read_parquet` / `read_csv_auto`; Save disabled or “Copy to Postgres / seed”.
2. **Import once** — bulk load file → create/fill a Postgres map table (preferred for continued editing at 100K) or materialize `seeds/map_*.csv`.
3. **Out of scope forever as writable SoT** — rewriting a 100K parquet on every Save is a full-file rewrite, not dirty-delta upsert.

## Dependencies

- ADR-0022 bind wizard UX (column pickers) reusable for file columns.
- Stress data under `/app2/stress-test/100k` / `scripts/stress/` as scale reference.

## Success sketch

- User can point at an external parquet, map From/To, preview ApplyKeyMap without loading all rows into `.dwhproj.json`.
- For editing: explicit “Import to Postgres map…” lands in the ADR-0022 path.
