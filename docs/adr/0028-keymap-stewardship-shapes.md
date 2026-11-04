# ADR-0028 — KeyMap stewardship shapes (attrs + SCD optional)

## Status

**Accepted** (2026-11-03) — Merged SoT: [`openspec/specs/keymap-stewardship-shapes/`](../../openspec/specs/keymap-stewardship-shapes/). Change record: [`openspec/changes/keymap-stewardship-shapes/`](../../openspec/changes/keymap-stewardship-shapes/).

## Context

Creating and editing **all useful mapping shapes** in one editor — seed, live Postgres, ref, composite From, attributes, and time-aware versions — is a primary “wow” surface for the product ([ADR-0005](0005-ux-blow-away.md), [ADR-0007](0007-visual-pipeline-editor-killer.md)), not a side feature of Join fix-up.

Today:

| Capability | Status |
|---|---|
| From→To (+ composite From) | [ADR-0020](0020-join-key-mapping.md), [ADR-0024](0024-keymap-composite.md) |
| Extra columns as attrs (`reason`, notes, scores…) | [ADR-0022](0022-keymap-postgres-live-bind.md) — IR + source bind; seed/create UX still defaults to bare `from,to` |
| Point-in-time as key part (`as_of_day` in From) | Covered by composite From |
| Range SCD / valid-from–valid-to Apply | **Not** in contract — ApplyKeyMap is equality join only |

Stewardship maps in the wild almost always want at least a **reason** (or equivalent) column available, and often **effectivity**. Making those *mandatory* would punish simple alias maps. Making them *unavailable* would leave the wow incomplete.

## Decision

### 1. Product thesis

KeyMap create/edit SHALL support the mapping shapes DE actually maintain — not only the minimal join remapper. Join Apply remains the narrow path ([ADR-0020](0020-join-key-mapping.md) § ApplyKeyMap / dbt join = From→To); stewardship columns and time modes ride beside that path.

### 2. Attributes — available, never required

- Every KeyMap create/edit path (seed, source, ref) SHALL allow **optional attribute columns** beyond From/To (e.g. `reason`, `confidence`, `changed_by`, free-form notes).
- Default new map MAY start as `from[, …], to` only; the UI SHALL make adding attrs a first-class action (not a Postgres-bind-only afterthought).
- Seed export header = `from_columns…, to_column, editable_columns…` when attrs exist.
- ApplyKeyMap / export join continue to use **From→To only**; attrs are preserved in the map relation for humans, CI review, and quality checks ([ADR-0027](0027-mapping-quality-checks.md)), not injected into Join ON.

### 3. Time / SCD — available modes, not a forced schema

The product SHALL expose **optional** time-aware modes; authors pick one (or none):

| Mode | Semantics | Apply |
|---|---|---|
| **None** (default) | Classic unique From → To | Equality join (today) |
| **Point-in-time key** | Effectivity is part of From (e.g. `id + as_of`) | Composite From ([ADR-0024](0024-keymap-composite.md)) — already Accepted |
| **Range SCD** | Rows carry `valid_from` / `valid_to` (names configurable); uniqueness is From + non-overlapping ranges | Temporal Apply with locked half-open predicate (below) |

**Range predicate (locked):**  
`event_time >= valid_from AND (valid_to IS NULL OR event_time < valid_to)`  
(`NULL` valid_to = open end). Inclusive/exclusive is **not** configurable per map in v1.

- Range columns are **stewardship/schema options**, not mandatory seed columns.
- Overlap validation belongs in the editor (and optional dbt tests on export), not silent coalesce. Gaps are observable, not auto-filled.
- Multi-To and automatic fuzzy SCD matching remain out of scope (same as ADR-0024 / ADR-0019).

### 4. Create & edit parity

Wizard / empty-map / seed import / live bind SHALL present the same shape choices: storage → From/To (arity) → optional attrs → optional time mode. Missing a shape in one entry point is a product bug relative to this ADR.

## Consequences

- Does not reverse ADR-0020 join semantics or ADR-0022 “attrs not in ON”.
- Extends seed header and editor beyond bare `from,to` when attrs/SCD enabled.
- Range SCD needs Apply `as_of_column` (or explicit as-of) + export emit path.
- Mapping quality checks may later group/filter on attrs and effectivity; not required for this ADR’s first slice.

## Out of scope (this ADR)

- Forcing `reason` or date columns on every map.
- Full historization UI for non-KeyMap dimensions.
- Warehouse-native SCD engines beyond what Apply/export emit.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0024](0024-keymap-composite.md), [ADR-0027](0027-mapping-quality-checks.md)
- OpenSpec (when opened): `openspec/changes/keymap-stewardship-shapes/`
