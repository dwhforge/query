# ADR-0002: Multi-query workspace

## Status

Accepted (2026-10-24)

## Context

A linear `Vec<TransformationStep>` cannot express two sources and Merge (core of PQ and complex dbt marts). We need a model that:

- scales to PQ Applied Steps / multiple queries;  
- compiles to one DuckDB SQL for preview;  
- expands into dbt `source` / `stg_` / `int_` / `mart_` with `ref()`.

## Decision

Canonical wire/IPC model — **Workspace**:

```rust
struct Workspace {
    queries: Vec<QueryDef>,
    focus_query_id: String,
}

struct QueryDef {
    id: String,      // stable uuid/slug
    name: String,    // human / dbt model stem
    steps: Vec<TransformationStep>,
}
```

Rules:

1. Each query is an ordered step list (like PQ Applied Steps).  
2. A query’s first step is `Load*` **or** a step that references other queries (`Join` / `Append`) once sources exist in their own queries.  
3. In practice: source-queries start with `Load*`; transform-queries may start with `Join`/`Append`/`CustomSql`.  
4. `focus_query_id` is the query for Preview and for the final mart on export.  
5. Cycles via `right_query_id` / `other_query_ids` are forbidden (detected at compile).

CTE naming: `q_<sanitized_id>_s<idx>` (stable for debug SQL).

Backward compatibility: a bare `steps: TransformationStep[]` in commands is accepted as a workspace with one query `main`.

## Consequences

- UI: query list + steps of the selected query + preview focus.  
- Compiler and dbt producer take `&Workspace`, not only a step slice.  
- Tests: single-query regression + two-query join.
