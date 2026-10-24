# ADR-0009: Project + Explorer tree (reuse, don't invent)

## Status

Accepted (2026-10-24)

## Context

The UI needs a left **Explorer (tree)**. That implies a durable container above a flat query list. We should map to industry concepts (dbt + Power Query + IDE), not invent new nouns.

## Decision — entity map

| Our term | Reuses | Role |
|----------|--------|------|
| **Project** | dbt project / IDE project | Saved unit of work on disk: name, path, settings |
| **Source** | dbt `sources` + PQ “Get Data” connection | Registered input: CSV/Parquet path or Postgres connection + schema.table |
| **Query** | Power Query query / our `QueryDef` | Transform chain (Applied Steps); may start from a Source or Join |
| **Workspace** | in-memory graph (keep) | Runtime view inside an open Project: `queries` + `focus_query_id` |

Do **not** introduce parallel names like “PipelinePack”, “DatasetHub”, “VibeSpace”.

### Ownership

```text
Project
  id, name, root_path?
  sources: Source[]
  workspace: Workspace          # queries + focus
  dbt_target: V1 | V2           # default export target
```

`Source` is the catalog entry for inputs. A Query that `LoadCsv`/`LoadPostgres` **binds** to a Source (by id) when possible; early slice may still embed path/conn in the Load step and mirror into Sources for the tree.

### Explorer tree (UI)

**VS Code–like section headers:** each group (`Sources`, `Queries`, `Export`) has a twisty + inline **`+` action** (and secondary actions as needed, e.g. Postgres on Sources). Familiar, dense, keyboard-friendly — do not invent a custom accordion chrome.

```text
Explorer
  Project «name»
  Sources                    [+] [PG]
  ▾ csv  sample.csv
  ▾ csv  dim_region.csv
  Queries                    [+]
  ▾ fact_sales  ★
  Export                     [+]
  ▾ dbt (v1)
```

- `+` on Sources → add CSV (primary); PG → Postgres form.  
- `+` on Queries → new query (same as add CSV source→query for now; later: empty query / from selected source).  
- `+` / click on Export → export dbt.  
- Click Source → select bound query if any.  
- Click Query → select on canvas + inspector.

### Persistence (next)

- Save/load `project.json` (or `.dwhproj`) under `root_path`.  
- Optional: project root = future dbt export root (same folder convention as dbt).

## Consequences

- Left rail is Explorer over **Project**, not a second query list.  
- Canvas remains the killer visual surface; Explorer is navigation (VS Code / dbt Cloud pattern).  
- dbt export continues to project from Workspace; Sources feed `sources.yml`.  
- Postgres stays a Source kind, not a special top-level invent.
