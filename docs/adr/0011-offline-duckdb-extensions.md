# ADR-0011: Sidecar extensions next to the app (bundled DuckDB)

## Status

Accepted (2026-10-25)

## Context

Users need **air-gapped startup**: no CDN `INSTALL`, nothing to configure. DuckDB is already **bundled** into the process (`duckdb-rs` / `bundled` feature). Extensions must live in **one folder beside the app** and be `LOAD`ed from disk.

S3/HTTP object reads still need network to the bucket — that is separate from extension install.

## Decision

1. Ship layout:

```text
DWH-RS-QUERY          # binary (DuckDB linked in-process)
extensions/
  postgres_scanner.duckdb_extension
  httpfs.duckdb_extension
  aws.duckdb_extension
```

2. Runtime: **only** `LOAD '/abs/path/to/*.duckdb_extension'` — **never** `INSTALL` from the network.  
3. Discovery order: Tauri `resource_dir/extensions` → `{exe_dir}/extensions` → `DWH_EXTENSIONS_DIR` → dev `src-tauri/extensions`.  
4. Fetch/populate once on a networked machine: `scripts/fetch-duckdb-extensions.sh` → copies into `src-tauri/extensions` (+ repo `extensions/`).  
5. Tauri bundles `src-tauri/extensions/*` as resources.  
6. Local Parquet/CSV = DuckDB core; `s3://` needs `httpfs`; Postgres needs `postgres_scanner`.

## Consequences

- Release artifacts must include the `extensions/` folder.  
- Dev: run the fetch script once after clone.  
- No dependency on `~/.duckdb/extensions` or Wi‑Fi at startup.
