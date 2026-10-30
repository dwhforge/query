# ADR-0001: Product positioning — dbt-first, PQ-path

## Status

Accepted (2026-10-24)

## Context

**DWHForge Query** (formerly referred to as DWH-RS-QUERY in early docs — [ADR-0016](0016-product-rename-dwhforge-query.md)) started as a linear DuckDB transform preview. Goals were refined:

1. **Near-term:** a tool to build **real, complex dbt** from one or many sources.  
2. **Required architectural approach:** cover the Power Query model (multi-query, Merge/Append).  
3. **Long-term:** Power Query UX closeness takes priority over “dbt-only”.

Do not confuse with Power BI: the reference is **Power Query** (Get Data / Applied Steps / Merge), not PBI reports.

Licensing: **Business Source License 1.1** (Apache-2.0 after four years); documentation stays in English.

## Decision

- **v1 north star = dbt help tool** (DuckDB preview + export of a runnable dbt project).  
- **Canonical data model = multi-query workspace** (PQ-like), not a forever-linear chain.  
- Exporters (dbt, later Polars) are graph projections; runtime preview is DuckDB CTE/SQL.  
- Language **M is not a goal**; PQ operation semantics are expressed as SQL/DuckDB + AST.  
- When PQ closeness becomes the main priority, UI/transform catalog emphasis shifts — not the graph model.  
- Separate long goal: **two-way visual ↔ dbt/SQL** (Delphi-like) — [ADR-0004](0004-two-way-visual-text.md). Does not block v1; requires AST-as-IR now.  
- As a visual tool: **UX must blow everyone away** from the first horizon — [ADR-0005](0005-ux-blow-away.md). Do not trade convenience for feature parity.  
- **Ultimate UI killer feature:** visual pipeline editor — [ADR-0007](0007-visual-pipeline-editor-killer.md).  
- **dbt v1 + v2** export support is required; V1 may ship first — [ADR-0006](0006-dbt-version-matrix.md).  
- **PostgreSQL is a mandatory source** — [ADR-0008](0008-postgres-required.md).

## Consequences

- Join/Append and multiple sources are must-haves before “complex dbt”, not afterthoughts.  
- The linear prototype (`Vec<Step>`) remains the special case of one query in a workspace.  
- v1 **baseline** success metric: `dbt run` on a generated project with ≥2 sources and ≥1 join.  
- **Active** success metric: return-and-edit loop + investigation — [ADR-0018](0018-return-and-edit.md).  
- Do not build UI that edits only dbt text without writing back into Workspace.
