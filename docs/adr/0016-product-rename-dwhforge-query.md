# ADR-0016: Product rename — DWHForge Query

## Status

Accepted (2026-10-25)

## Context

Working name **DWH-RS-QUERY** / `dwh-rs-query` was internal. Public brand should be clearer.

## Decision

| Layer | Name |
|-------|------|
| Product / UI / window title | **DWHForge Query** |
| Local data dir | `~/.dwhforge-query/` (secrets + settings) |
| Tauri identifier | `com.dwhforge.query` |
| Repo / Cargo crate paths | may stay `dwh-rs-query` until a mechanical rename; docs call out the brand |

Under `~/.dwhforge-query/`:

| File | Role |
|------|------|
| `secrets.json` | Connection secrets (mode `0600`) — not in `.dwhproj.json` ([ADR-0012](0012-connections.md)) |
| `settings.json` | App defaults / last-used (`default_target_dialect`, `default_dbt_target`) — seeds new/demo projects; open projects keep their own IR |

Per-project `target_dialect` / `dbt_target` stay in `.dwhproj.json` ([ADR-0014](0014-query-execution-affinity.md)).

## Consequences

- Marketing and UI lead with DWHForge Query.
- Migrating old `~/.dwh-rs-query` is not required (never shipped publicly).
