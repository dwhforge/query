# DuckDB extensions (staging)

Versioned downloads land here; the **ship folder** used at runtime is flat:

- `src-tauri/extensions/` — bundled with the Tauri app  
- `extensions/` — next to CLI / when running from repo root  

```bash
./scripts/fetch-duckdb-extensions.sh v1.4.0
```

See [ADR-0011](../../docs/adr/0011-offline-duckdb-extensions.md).
