# ADR-0007: Visual pipeline editor is the Ultimate UI killer feature

## Status

Accepted (2026-10-24) — still the UI killer. Next release deepens it with investigation + re-export ([ADR-0018](0018-return-and-edit.md)); it does not replace the canvas.

## Context

DWH-RS-QUERY has several product axes (dbt export, PQ-path, two-way SQL, DuckDB preview). ADR-0005 already demands blow-away UX. This ADR names the **single Ultimate UI killer feature** so design and engineering do not dilute it.

## Decision

### Killer feature

The **visual pipeline / workspace editor** is the Ultimate UI killer feature:

- Multi-query graph (sources + transforms + Join/Append edges)  
- Direct manipulation of steps and links  
- Instant DuckDB preview bound to focus  
- Clear path to export (dbt / later SQL) without leaving the visual flow  

Everything else (dbt fidelity, adapters, AI, two-way text) **amplifies** this editor; nothing may ship that makes the visual editor feel secondary or “form-ware around SQL”.

**Expensive checks** (Join diagnostics on large inputs, full-table uniqueness, …) **must not block editing**; their execution scope and progress must be explicit.

### Bar

Relative to Power Query’s Applied Steps + Merge UX and typical DAG tools:

- Faster to first Join+preview  
- Clearer graph of many sources  
- Less ceremony to export production-ready dbt  
- Delight-level polish (motion, density, keyboard) per ADR-0005  

### Implications for backlog

| Priority | Work |
|----------|------|
| P0 | Visual editor core loop: queries, steps, join edges, preview, empty/first-run |
| P0 | Performance of preview + interaction latency |
| P0 / next | Step schema, re-export, Join diagnostics — [ADR-0018](0018-return-and-edit.md) · [DESIGN.md](../DESIGN.md) §9–§10 |
| P1 | dbt export (v1 target) as one gesture from the same canvas — **baseline largely landed** |
| P2 | Two-way SQL/dbt text (ADR-0004) — **deferred** after safe re-export |
| P2 | Broader PQ transform catalog — after next-release DoD |

Canvas/graph view is in-scope for the killer feature (not “list-only forever”). List+detail may ship first as a thin slice; the destination UX is a **visual graph editor**, not a settings page.

## Consequences

- UI reviews ask: “Does this make the visual editor more killer?”  
- Avoid burying Join behind deep modals or multi-page wizards.  
- Marketing/OSS narrative leads with visual multi-source pipelines → dbt, not “yet another SQL runner”.  
- Complements ADR-0005 (principles) by naming the feature that must embody them.
