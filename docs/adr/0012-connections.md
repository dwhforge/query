# ADR-0012: Connections — first-class credentials (global)

## Status

Accepted (2026-10-25) · Amended (2026-10-28) — connections are **app-global**; sources stay per-project.

## Context

Postgres DSNs and S3 parameters (endpoint, keys, `USE_SSL`, `VERIFY_SSL`, …) were heading toward ad-hoc UI (`prompt`, inline in Load steps, `localStorage`). That does not scale, leaks secrets into Applied Steps, and blocks MinIO / self-signed / multi-account workflows.

Industry pattern (dbt profiles, PQ “data source settings”, IDE connection manager): **Connection** ≠ **Source** ≠ **Query**.

Users typically reuse the same warehouse / MinIO across many projects. Storing connection shells only inside each `.dwhproj.json` forced re-entry and duplicated secrets under `project_id`.

## Decision

### Entity map (extends ADR-0009)

| Term | Role | Scope |
|------|------|--------|
| **Connection** | How to authenticate / reach a system (PG DSN, S3 endpoint+creds+TLS flags) | **Global** (app home) |
| **Source** | What object to read (`schema.table`, `s3://…/file.parquet`, local path) **via** optional `connection_id` | **Per-project** |
| **Query** | Transform chain; Load* may bind `source_id` / `connection_id` | Per-project |

```text
~/.dwhforge-query/
  connections.json          # Connection shells (id, name, kind, non-secret params)
  secrets.json              # connection_id → secret (global); legacy projects{} migrated
  settings.json

Project (.dwhproj.json)
  sources: Source[]         # objects; reference connection_id when remote
  workspace: Workspace      # queries / steps — prefer ids, not secrets
  # connections[] omitted / empty on disk (runtime UI attaches global list)
```

### Connection kinds (v1)

- `postgres` — `connection_string` (URI or key=value)
- `s3` — DuckDB httpfs secret params: provider (`config` \| `credential_chain`), region, endpoint, key/secret/token, `url_style`, `use_ssl`, `verify_ssl`

### Runtime

1. Preview/export receive `Workspace` **plus** `connections[]` (global list loaded for the session).  
2. Engine materializes DuckDB `CREATE SECRET` for each used S3 connection (by id).  
3. `LoadPostgres` resolves `connection_id` → DSN before `postgres_scan` / catalog browse.  
4. Load steps **must not** be the primary store of passwords; legacy inline DSN allowed only for backward compat.
5. Host RPC: `get_global_connections` / `set_global_connections`.

### UI

- Explorer section **Connections** with `+` (PG / S3) and a **Global** hint.  
- Postgres object picker & S3 path dialog **select an existing Connection** (or create one in the same flow, still saved as global Connection).  
- No `window.prompt` for credentials.

### Persistence

- Connection **shells** → `~/.dwhforge-query/connections.json`.  
- Secrets (PG DSN, S3 keys) → `~/.dwhforge-query/secrets.json` under top-level `connections[connection_id]` (mode `0600`).  
- Legacy `secrets.json → projects[project_id][connection_id]` and project-embedded `connections[]` are **migrated** into the global store on load/save (no overwrite of richer existing secrets).  
- Project file does **not** own connections.  
- OS keyring remains optional later; home-dir file is the v1 vault.

## Consequences

- ADR-0009 Explorer Connections are shared across projects; Sources remain project-local.  
- COMPETITIVE DE/DBA story: connection manager, not string soup.  
- Catalog import (future) attaches to Connections, not raw DSNs in every Source.  
- Opening project A then project B reuses the same PG/S3 credentials by `connection_id`.
