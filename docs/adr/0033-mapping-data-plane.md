# ADR-0033 — Mapping rows data plane (out of IR)

## Status

**Accepted** (2026-11-04) — slice 1: enforce warehouse maps without row bodies in the project document. Seed-map offload is a later `format_version` bump. OpenSpec: [`openspec/changes/mapping-data-plane/`](../../openspec/changes/mapping-data-plane/).

## Context

Large KeyMaps must not ride every project save/RPC as a full `entries[]` list. [ADR-0022](0022-keymap-postgres-live-bind.md) already requires **source** maps: WH is SoT, paged reads, dirty delta writes. Seed maps still keep rows inline in the IR (export CSV is the portable SoT after export).

This ADR is the **storage-model** stage after typed wire / format_version / lifecycle / UI-host decomposition. It must not reopen ts-rs work.

## Decision

1. **Source maps:** project JSON MUST persist metadata only (`entries: []`). Load soft-clears any legacy inline rows. Editor continues paged `read_key_map` + delta `write_key_map`.
2. **Seed maps (v1):** may keep inline `entries` in the project document (small/portable). Export tree CSV remains the post-export SoT.
3. **Future (format_version ≥ 2):** optional offload of large seed dictionaries to a sidecar / Parquet store with paged host reads — separate migration, not mixed into this slice.
4. **RPC:** do not send the full dictionary on every preview/project echo; source path already pages. Seed path may still send entries when the editor holds them in session.

## Consequences

- Migrate on load: strip `entries` when `storage.kind == source`.
- UI save path already uses `mapForProjectAst` ([ADR-0032](0032-ui-host-decomposition.md) KeyMap service).
- Bumping seed offload requires ADR amendment + `format_version` step.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0030](0030-project-format-version.md), [ADR-0032](0032-ui-host-decomposition.md)
