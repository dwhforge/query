# ADR-0004: Two-way visual editor ↔ text (dbt / SQL)

## Status

Accepted (2026-10-24) — **long-term**. Near-term does **not** implement H1/H2; safe re-export first — [ADR-0018](0018-return-and-edit.md).

## Context

A distinct product goal (Delphi-like): the **visual editor** and a **text editor** (dbt models and/or pure SQL) work as two-way tools — edits in one reflect in the other without losing meaning.

This is not “export once to dbt”. Round-trip needs a canonical IR and disciplined projections.

## Decision

### Horizon

| Phase | When | What |
|-------|------|------|
| **H0 (now)** | v1 foundation | Workspace AST = **single source of truth**. Visual edits AST; SQL/dbt are **one-way projections**. Read-only “Show SQL” is OK. |
| **H1** | After the *Return and edit* acceptance criteria in [ADR-0018](0018-return-and-edit.md) are met | Split view: visual steps + editable SQL **per step** with parse-back for a **whitelist** of step kinds. Failed parse → keep text, mark step dirty. |
| **H2 (Delphi-like)** | later product priority | Full two-way: graph/canvas ↔ dbt project files ↔ optional pure-SQL workspace. External edits to exported `.sql` can be **imported/reconciled** when structure matches; otherwise conflict UI. |

H2 timing **does not** block the v1 dbt tool. H0 architecture must not close the door on H1/H2 (no “SQL-only UI state without AST”).

### Canonical model

1. **Workspace AST** (queries + steps) — canon for preview and visual editor.  
2. **Projections:** GraphCompiler → DuckDB SQL; DbtProducer → files; future SqlBundle → multi-file pure SQL.  
3. **Inverse projections (H1+):** step-kind-specific parsers, not a universal “SQL → AST”.  
4. Pure SQL / dbt text are first-class **views** on the same IR, not a parallel truth in v1.

### Non-goals (until H2)

- Round-trip of arbitrary hand-written dbt macros/Jinja.  
- Bit-exact re-emit of user formatting (later via raw overlays).  
- Bidirectional sync with Power Query M.

## Consequences

- UI always writes Workspace; “Export dbt” is not the only place of truth.  
- CustomSql / dirty text steps — escape hatch with explicit `source: visual | text`.  
- PQ closeness and two-way editing are different axes; two-way strengthens both dbt-help and the PQ path.  
- Later increments must not emit SQL that cannot be attributed to a step/query id.
