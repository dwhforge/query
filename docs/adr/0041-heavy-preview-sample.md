# ADR-0041 — Heavy preview: sample first, full on demand

## Status

Accepted (2026-11-07)

## Context

Power Query always shows at least a sample of the current step. A previous UI guard skipped auto-preview entirely when the focused query Applied a large seed KeyMap (or when the focus id was one of three Mapping-quality lab query names). The Data panel then showed an empty “uses the full map” message with no way to load rows from that surface.

Help labs (including Mapping quality) are ordinary projects generated on the fly for quick setup. Special-casing lab query ids in the general preview path treats the lab as a second product mode and drifts from that model.

Structural preview already wraps the focus SELECT in `LIMIT 50` ([compiler](../../crates/dwh-pipeline/src/compiler.rs)). The expensive part of a large seed Apply is shipping and compiling the map, not returning thousands of output rows. An empty panel does not avoid that cost for the user who still needs to see data — it only removes the PQ-shaped feedback.

## Decision

1. **Heaviness is data-shaped, not lab-shaped.** A focus is heavy when it needs at least one seed KeyMap with ≥ 5000 `entries`. Named lab query ids (`quality_*` and any future demo ids) SHALL NOT force heaviness by themselves.
2. **Auto-preview always runs a sample.** Selecting a node (including a heavy one) runs the normal structural preview with the sample row LIMIT (50). The Data panel shows those rows. Cancel remains available while the host works.
3. **Full preview is explicit.** For a heavy focus, the Data chrome offers **Load full**: the same preview path with no output row LIMIT. The UI labels whether the grid is a sample or a full preview. Switching focus resets to sample policy for the new focus.
4. **Session cache.** A heavy sample or full result MAY be cached in-session by focus + map fingerprint so a re-click does not re-ship the dictionary. Cache invalidates when that fingerprint changes.
5. **Labs stay ordinary projects.** Overview / check tooling may still address queries by the ids the generator wrote into that project. That is pack configuration, not a global preview exception.

## Consequences

- Empty “no auto-preview” Data state for heavy focuses is removed.
- First click on a heavy ApplyKeyMap can still be slow (map transport); sample rows appear afterward. Full can be slower and return many rows (PreviewTable is virtualized).
- Amends the practical behavior assumed by ADR-0026’s lab: preview policy is this ADR, not id allowlists.
- OpenSpec: `openspec/changes/heavy-preview-sample/` → merge to `openspec/specs/heavy-preview-sample/`.
