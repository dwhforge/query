# ADR-0012: Connections — first-class Project credentials

## Status

Accepted (2026-10-25)

## Context

Postgres DSNs and S3 parameters (endpoint, keys, `USE_SSL`, `VERIFY_SSL`, …) were heading toward ad-hoc UI (`prompt`, inline in Load steps, `localStorage`). That does not scale, leaks secrets into Applied Steps, and blocks MinIO / self-signed / multi-account workflows.

Industry pattern (dbt profiles, PQ “data source settings”, IDE connection manager): **Connection** ≠ **Source** ≠ **Query**.

## Decision

### Entity map (extends ADR-0009)

| Term | Role |
|------|------|
| **Connection** | How to authenticate / reach a system (PG DSN, S3 endpoint+creds+TLS flags) |
| **Source** | What object to read (`schema.table`, `s3://…/file.parquet`, local path) **via** optional `connection_id` |
| **Query** | Transform chain; Load* may bind `source_id` / `connection_id` |

```text
Project
  connections: Connection[]     # credentials + endpoint params
  sources: Source[]             # objects; reference connection_id when remote
  workspace: Workspace          # queries / steps — prefer ids, not secrets
```

### Connection kinds (v1)

- `postgres` — `connection_string` (URI or key=value)
- `s3` — DuckDB httpfs secret params: provider (`config` \| `credential_chain`), region, endpoint, key/secret/token, `url_style`, `use_ssl`, `verify_ssl`

### Runtime

1. Preview/export receive `Workspace` **plus** `connections[]`.  
2. Engine materializes DuckDB `CREATE SECRET` for each used S3 connection (by id).  
3. `LoadPostgres` resolves `connection_id` → DSN before `postgres_scan` / catalog browse.  
4. Load steps **must not** be the primary store of passwords; legacy inline DSN allowed only for backward compat.

### UI

- Explorer section **Connections** with `+` (PG / S3).  
- Postgres object picker & S3 path dialog **select an existing Connection** (or create one in the same flow, still saved as Connection).  
- No `window.prompt` for credentials.

### Persistence (follow-up)

- `project.json` may hold connection shells; secrets → OS keyring / encrypted vault later.  
- Until vault: connections live in Project memory/disk with clear “secrets in project” warning — still better than scattering them across steps.

## Consequences

- ADR-0009 Explorer gains Connections above Sources.  
- COMPETITIVE DE/DBA story: connection manager, not string soup.  
- Catalog import (future) attaches to Connections, not raw DSNs in every Source.
