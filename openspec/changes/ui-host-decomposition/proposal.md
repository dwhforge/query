# Proposal: ui-host-decomposition

## Why

Cut scenario logic out of `App.tsx` / `api.rs` without behavior change (ADR-0032).

## In scope (slice 1 — checks)

- Application service for MappingCheck / CheckRun / frozen remap
- Thin App wiring
- Tests for service outcomes

## Out of scope (this slice)

- KeyMap editor extraction
- Host `commands/*` (next slices)
- Mapping data plane
