# ADR-0031 — Preview/check execution ownership (DuckDB session)

## Status

**Accepted** (2026-11-03) — document + tighten the **existing** host mechanism; no workflow engine. OpenSpec: [`openspec/changes/execution-lifecycle/`](../../openspec/changes/execution-lifecycle/).

## Context

After typed wire ([ADR-0029](0029-typed-wire-contract.md)) and project `format_version` ([ADR-0030](0030-project-format-version.md)), the next risk is races: concurrent DuckDB work, cancel semantics, and UI applying a stale preview/check result after the project or request moved on.

Inspiration from platform proposals (job handles, session ownership) stays **out of product** for now — we fix the real `dwh-host` paths.

## Decision — current truth (normative)

1. **One DuckDB session** lives in `HostState` (`db: Mutex<…>`). The host process owns connections; the renderer does not open DuckDB.
2. **Heavy RPCs** (preview, join prepare/diagnostics, KeyMap fuzzy, etc.) share one worker via `heavy_pending` + lanes:
   - **Preview** — newest wins; pending peer gets `HostError::cancelled` (“Preview superseded.”); running query may be interrupted via `QueryCancelHandle`.
   - **Analysis** — same supersede rules within the lane.
   - **Mutation** (KeyMap R/W) — FIFO; never superseded.
3. **Cancel** means: interrupt the in-flight DuckDB query and/or drop superseded pending replies. It does **not** roll back committed KeyMap mutations.
4. **Results** are correlated by IPC `id`. The renderer must ignore replies whose `id` is no longer the latest request for that UI surface (stale-result guard). Host may fingerprint args for preview cache; cache is invalidated after mutations.
5. **Project IR** for checks stays client-authored until an explicit save; a CheckRun is not applied if the UI has moved to another check/map revision (ADR-0027 closed loop remains authoritative for check freshness).

## Decision — tighten (in this change)

- Document the above in OpenSpec scenarios.
- Ensure superseded/cancel paths always use structured `HostError::cancelled` with `error_detail`.
- Renderer: one shared helper to drop stale IPC replies by request generation (preview + check run).
- No universal job registry, no multi-session DuckDB, no durable job store.

## Out of scope

- Mapping data plane / paged KeyMap transport ([later](0029-typed-wire-contract.md) stage 5).
- Splitting `api.rs` / `App.tsx` except as needed for the stale-reply helper.

## References

- Host: `crates/dwh-host/src/api.rs` (`HeavyLane`, `enqueue_heavy`, `interrupt_running_query`)
- [ADR-0020](0020-join-key-mapping.md) (fuzzy path notes), [ADR-0027](0027-mapping-quality-checks.md)
