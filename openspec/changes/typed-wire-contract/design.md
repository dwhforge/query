# Design — typed-wire-contract

## Generation

- Crate: `dwh-pipeline` owns shared IR (+ `TS`).
- Bin: `crates/dwh-pipeline/src/bin/export_ts.rs` writes into repo `src/types/generated/`.
- Script: `scripts/export-ts-types.sh` (and `npm run types:generate`).
- CI: run export then `git diff --exit-code -- src/types/generated`.

## MappingCheck module

`crates/dwh-pipeline/src/mapping_check.rs` — structs matching ADR-0027 JSON field names (snake_case). Soft-migrate: empty vec on old projects without fields (already `#[serde(default)]`).

## HostError

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
enum HostError {
  Validation { message: String },
  Conflict { message: String },
  Unsupported { message: String },
  Cancelled { message: String },
  Internal { message: String, correlation_id: String },
}
```

IPC may still stringify for legacy renderer paths; new paths prefer structured JSON.

## TS consumption

`src/types/mappingCheck.ts` re-exports generated types; keep `FrozenRemapPreview` hand-written until promoted (session-only UI freeze).
