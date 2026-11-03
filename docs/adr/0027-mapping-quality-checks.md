# ADR-0027 — Mapping quality checks (closed loop)

## Status

**Accepted** (2026-11-03) — v1 implemented. Merged SoT:
[`openspec/specs/mapping-quality-checks/`](../../openspec/specs/mapping-quality-checks/).
Change record: [`openspec/changes/mapping-quality-checks/`](../../openspec/changes/mapping-quality-checks/).

## Context

[ADR-0026](0026-mapping-quality-overview.md) shipped a Help-lab overview: whole-mapping observations, bounded samples, drill-down into Join Lens. That proved the macro view, but the loop stops at illustrative keys. There is no durable check object, no cohort-as-predicate, no comparable recompute after KeyMap edits, and no path from “my map” attributes to a stewardship cycle.

Join Lens remains the place to inspect rows and edit mappings ([ADR-0020](0020-join-key-mapping.md)). Return-and-edit of projects/exports is [ADR-0018](0018-return-and-edit.md). Silent fuzzy Join ON stays forbidden ([ADR-0019](0019-join-lens-ai-narrator.md)).

The missing product is not another visual matrix. It is a **saved check** that binds overview → Lens → remap → recompute with an honest Δ.

## Decision (contracts)

### 1. MappingCheck ≠ CheckRun

- **MappingCheck** (durable): references to KeyMap and input queries/sources, chosen grouping/check attributes, and the cohort **predicate** (selection condition). Survives sessions; lives in the project.
- **CheckRun** (immutable result of one execution): versions/fingerprints of inputs used, aggregate payloads, run timestamp. Each recalculation creates a new CheckRun; it does not overwrite the check definition.

Ephemeral Inspect queries from ADR-0026 remain a prototype bridge, not the long-lived object.

### 2. Δ must attribute change, not only hash totals

Comparing two CheckRuns SHALL explain *what moved*:

- mapping changed,
- inputs changed,
- both,
- or comparison is **limited** when a source version cannot be established.

A KeyMap fingerprint alone is insufficient. Timestamp and aggregate hash alone do not prove attribution. UI must not present an unattributed numeric Δ as a clean before/after of the map.

### 3. Dynamic cohort for investigation; frozen ops for apply

- Opening Join Lens for a check uses the check’s **current predicate** (dynamic cohort).
- Before confirming a batch remap, the product freezes the concrete From→To changes and the **expected KeyMap revision**.
- If inputs or map revision diverge after preview, a new preview is required. Confirm must not apply against a different link set than the user reviewed.

KeyMap editor and existing Save/Apply paths remain the **only** way links change ([ADR-0020](0020-join-key-mapping.md)). No second mapping store.

### 4. Accept has two distinct meanings

| Action | Effect |
|--------|--------|
| Accept proposed links | Mutates KeyMap (via existing draft → Save / Apply) |
| Treat observed difference as allowed | Records a decision **on the check**; does **not** change links and must not hide the observation without an explicit explanation |

Conflating these is forbidden.

## First finished scenario (v1 scope)

Own KeyMap → user-chosen grouping attributes → saved MappingCheck → cohort in Join Lens (predicate, pagination) → explicit remap via existing KeyMap mechanisms (preview + confirm with frozen From→To and expected revision) → new CheckRun → comparable Δ with attribution (or limited-comparability label).

**Out of scope for v1:** owners, approvals, tickets, new matcher/LLM, automatic fuzzy merge, Help-lab-only attributes as the only mode, replacing Join Lens or KeyMap editor.

## Consequences

- New durable project concepts: MappingCheck, CheckRun (exact IR shape deferred to OpenSpec design until Accepted).
- Overview becomes a check runner/viewer for the user’s map, not only a Help lab.
- ADR-0026 lab remains a valid demonstration and may seed UX; production path is checks on project maps.
- OpenSpec: `openspec/changes/mapping-quality-checks/` — implement only after this ADR is Accepted and the change is reviewed (proposal → specs → design → tasks).

## References

- [ADR-0018](0018-return-and-edit.md) — return and edit (projects / export loop)
- [ADR-0019](0019-join-lens-ai-narrator.md) — no silent fuzzy Join ON
- [ADR-0020](0020-join-key-mapping.md) — KeyMap SoT and Apply
- [ADR-0026](0026-mapping-quality-overview.md) — overview prototype / lab
