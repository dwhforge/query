# Design: Return-and-edit foundation

## Context

- Workspace AST is canonical; schema is a **compilation artifact** (ADR-0018 §2), not a second store.  
- `infer_workspace_schemas` + portable Append/Rename already exist when `load_seeds` is provided.  
- UI/`export_dbt` currently call `DbtProducer.produce` with empty seeds.  
- Re-export has no manifest/hashes yet (overwrite or ad-hoc).

## Approach

### 1. Seed collection (engine → export)

At export (and optionally Model-tab preview), resolve Load* columns:

| Source | How |
|--------|-----|
| `LoadPostgres` | Existing `describe_postgres_object` (resolved DSN via connections) |
| `LoadCsv` / `LoadParquet` | DuckDB `DESCRIBE` / `LIMIT 0` probe on the same preview session |

Output: `HashMap<query_id, Vec<column_name>>` passed into `produce_with_seeds` / `preview_dbt_model_sql_with_seeds`.

Failures: loud per query (missing DSN, missing file, describe error) — do not silently export with unknown schema when the chain needs it for portable Append/Rename. If schema stays unknown and postgres Append would need jinja/`left_dbt`, keep current fallbacks; prefer failing when Rename→Append cannot be emitted safely.

### 2. Producer API

Extend producer without breaking CLI:

- `produce(..., load_seeds: &HashMap<…>)` or `produce_with_seeds`  
- CLI `dwh-export`: optional later; v1 UI path must pass seeds  
- Infer schemas once per export; compile all models with that map  

### 3. Safe re-export (ADR-0018 §3)

Beside export root (or under it, documented):

```text
.dwhforge-export.json   # manifest: version, owned paths, content hashes, pipeline/workspace fingerprint
```

Algorithm:

1. Plan new file set + contents in memory (or temp dir).  
2. If prior manifest exists: for each owned path, if file on disk hash ≠ recorded hash → **refuse** (list conflicts).  
3. Else: write all planned files; remove owned paths absent from new plan; write new manifest.  
4. No writes before step 2 passes. Unowned files untouched.

**Name stability tests:** same models when only `focus_query_id` changes; adding an unrelated Load query does not rename existing models.

### 4. e2e

Minimum fixture (prefer DuckDB target for CI without external PG):

- Two CSV (or seeded) queries → Rename + Append or Join → export → `dbt run` with profiles in tree → checksum/row compare against DuckDB preview of focus.

Postgres fixture documented as optional/manual if CI lacks PG; do not block merge solely on live PG if DuckDB e2e covers semantic parity of portable emit.

## Alternatives considered

| Idea | Why not now |
|------|-------------|
| Always jinja `get_columns_in_relation` | Diverges from preview; fails mid-CTE after Rename |
| Soft-overwrite hand-edits | Violates ADR-0018 first-ship contract |
| Full warehouse preview on every edit | ADR-0007 / 0014 — expensive; not this slice |

## Risks

- Describe latency on large remote tables → cache per connection+relation during one export only.  
- CSV type inference flaky → column **names** only for schema; types later.  
- Partial old exports without manifest → treat as “no prior ownership”; first export after upgrade writes manifest (may overwrite); document migration once.  
