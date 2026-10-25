# ADR-0016: Product rename — DWHForge Query

## Status

Accepted (2026-10-25)

## Context

Working name **DWH-RS-QUERY** / `dwh-rs-query` was internal. Public brand should be clearer.

## Decision

| Layer | Name |
|-------|------|
| Product / UI / window title | **DWHForge Query** |
| Local data dir | `~/.dwhforge-query/` (secrets, future app state) |
| Tauri identifier | `com.dwhforge.query` |
| Repo / Cargo crate paths | may stay `dwh-rs-query` until a mechanical rename; docs call out the brand |

Secrets for connections live in `~/.dwhforge-query/secrets.json` (not in `.dwhproj.json`). See ADR-0012 / ADR-0013 updates.

## Consequences

- Marketing and UI lead with DWHForge Query.
- Migrating old `~/.dwh-rs-query` is not required (never shipped publicly).
