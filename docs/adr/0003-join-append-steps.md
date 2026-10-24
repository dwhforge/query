# ADR-0003: Join and Append as first-class steps

## Status

Accepted (2026-10-24)

## Context

Without Merge/Append there is neither complex dbt nor a PQ path. `CustomSql` is insufficient: one `{{prev_step}}`, no model of a second dataset.

## Decision

Add to `TransformationStep`:

```rust
Join {
    right_query_id: String,
    join_type: JoinType, // Inner | Left | Right | Full
    left_on: Vec<String>,
    right_on: Vec<String>,
},
Append {
    other_query_ids: Vec<String>, // UNION ALL by column-name alignment
},
```

DuckDB preview SQL semantics:

- Join: `SELECT * FROM {{prev}} AS l <JOIN> q_<right>_sLAST AS r ON …`  
- Column name collisions: DuckDB `USING` when join keys share names; otherwise explicit `ON` (MVP may yield duplicate names → user Select/Rename).  
- Append: `SELECT * FROM {{prev}} UNION ALL BY NAME SELECT * FROM other`.

dbt export:

- Join/Append → `int_` / `mart_` models with `{{ ref('…') }}`.

## Consequences

- AI prompt and TS types update with the Rust enum.  
- Polars producer: `join` / `vstack` or `diag_concat`.  
- Fuzzy merge / anti-join — out of v1 (PQ later).
