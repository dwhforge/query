# Proposal: KeyMap stewardship shapes (attrs + SCD)

## Why

Editing real mapping tables — with optional `reason` / attrs and optional effectivity (point-in-time or range SCD) — is a core “wow” for DE, not an afterthought of Join remapping. ADR-0022 attrs exist for live Postgres; seed create and temporal Apply still feel like two-column-only.

## In scope

- Product contracts in [ADR-0028](../../../docs/adr/0028-keymap-stewardship-shapes.md) (**Proposed**).
- Attrs available on **all** KeyMap create/edit paths (seed / source / ref); never required.
- Seed CSV round-trip for attrs.
- Time modes: none | point-in-time (composite From, already shipped) | range SCD (new Apply/export).
- Editor validation for SCD overlaps/gaps when range mode is on.

## Out of scope

- Mandatory reason/date columns on every map.
- Multi-To maps.
- Auto fuzzy / silent temporal Join ON ([ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md)).
- Non-KeyMap dimension SCD tooling.

## Approach

1. Lock ADR-0028 + delta specs (attrs parity, then range SCD).
2. Slice A: seed + editor attrs parity with ADR-0022 IR (no Apply change).
3. Slice B: range SCD schema options + temporal Apply/export + overlap checks.

## Related

- ADR-0020 / 0022 / 0024 / 0027 / 0028
