# ADR-0029 — Typed Rust ↔ TypeScript wire contract (ts-rs)

## Status

**Accepted** (2026-11-03; closed 2026-11-04). OpenSpec merged: [`openspec/specs/typed-wire-contract/`](../../openspec/specs/typed-wire-contract/).

## Context

The Electron host speaks JSON over IPC. Today many shapes are hand-duplicated in `src/types/*.ts`, while Rust sometimes stores opaque `serde_json::Value` (notably MappingCheck / CheckRun on `Project`). That drifts, hides validation on the Rust side, and blocks honest typed errors.

Product sequence after ADR-0027/0028 fixes: **typed wire → format_version → execution lifecycle → UI/API decomposition → mapping data plane**. This ADR covers only the first stage. It is **not** project `format_version` (separate ADR) and not a general workflow engine ([adr_proposals](../adr_proposals/) 0034 inspiration only).

## Decision

1. **Rust is the source of truth** for persisted IR and IPC wire DTOs that cross the host boundary. TypeScript consumes **generated** types (`ts-rs`), not a parallel hand-written schema for those shapes.
2. **Domain vs wire:** domain types may exist without `TS`; wire DTOs / shared IR carry `Serialize` + `TS`. Mapping between them is explicit when shapes diverge.
3. **MappingCheck / CheckRun** are first-class Rust IR on `Project` (not `serde_json::Value`). TS helpers keep business logic; types come from generation.
4. **Typed errors:** host commands return a structured error enum (kind + message + optional correlation id). Plain string errors are transitional only.
5. **CI freshness:** regenerating bindings and `git diff --exit-code` (or equivalent) fails the build if generated TS is stale. Rust still validates inputs at runtime.
6. **Protocol version** (handshake capability) is independent of project file `format_version` (next stage).

## Out of scope (this ADR)

- Immutable workspace revisions / Parquet mapping store.
- Full decomposition of `App.tsx` / `api.rs` (follows once types exist).
- Replacing every legacy IPC payload in one PR — migrate by vertical slice (checks first, then KeyMap, then project I/O).

## Consequences

- Add `ts-rs` to `dwh-pipeline` (and host wire modules as needed).
- Commit generated files under `src/types/generated/`.
- Hand-edited copies of generated IR types are forbidden; UI-only session types may remain hand-written until promoted.

## References

- [ADR-0027](0027-mapping-quality-checks.md), [ADR-0013](0013-project-persistence.md)
- OpenSpec change: `openspec/changes/typed-wire-contract/`
