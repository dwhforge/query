# App-sidecar DuckDB extensions

Shipped next to the app. Bundled DuckDB loads via `LOAD` only — **no INSTALL**.

Populate:

```bash
../../scripts/fetch-duckdb-extensions.sh
```

Files: `postgres_scanner`, `httpfs`, `aws` (`.duckdb_extension`).
