# App-sidecar DuckDB extensions

These files ship **next to the application** (`extensions/`).

Bundled DuckDB loads them with `LOAD '…/extensions/<file>'` — **no INSTALL**, no network.

Required:
- `postgres_scanner.duckdb_extension` — Postgres
- `httpfs.duckdb_extension` — s3:// and https://
- `aws.duckdb_extension` — optional S3 credentials helper

Refresh: `../scripts/fetch-duckdb-extensions.sh`
