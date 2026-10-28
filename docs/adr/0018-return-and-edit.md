# ADR-0018: Return and edit — step schema, re-export, Join investigation

## Status

Accepted (2026-10-27)

## Context

v1 baseline proves first export → `dbt run`. That is not enough for regular use: if the editor only helps create the first project, users continue in the IDE and do not return.

Competitive overlap (visual + local + code out) is real. Durable value is **trust while editing**: investigate a step on real data, change logic, re-export a reviewable diff, leave checkable expectations in dbt.

Full two-way dbt/SQL round-trip ([ADR-0004](0004-two-way-visual-text.md)) remains long-term and too expensive as the next bet.

Product narrative and DoD checklist: [DESIGN.md](../DESIGN.md) §4, §8–§10. Join UI contract: [DESIGN.md](../DESIGN.md) §9.

## Decision

### 1. Near-term product bet = *Return and edit*

Ship one loop: connect → transform → preview → export → **change → re-export with clear diff**, with Join investigation on the canvas ([ADR-0007](0007-visual-pipeline-editor-killer.md) amplified, not replaced).

Success signal: external users finish real tasks **and come back**. Baseline `dbt run` without hand-edits remains necessary but not sufficient.

### 2. Step result schema — derived, not a second truth

The compiler derives result column names after each step (`Option<Vec<…>>`; types later) from the **Workspace AST** plus **source metadata** (catalog / describe). Schema is a **compilation artifact**, not an independently editable store.

- Schema propagation requires **explicit output names**. Steps with raw expressions and unknown output aliases produce an **unknown** schema (e.g. `GroupBy` aggregates without declared aliases; `CustomSql` / `SqlModel` without describe).
- Structural steps with known names update schema by rules (no SQL parser).
- `Load*` / `FromQuery` seed schema when metadata is available; unknown input → unknown downstream until a step re-establishes names (e.g. `SelectColumns`).
- When schema is known, Postgres Append/Rename use **portable name-aligned SQL** (ASCII-fold policy matching DuckDB `UNION ALL BY NAME`); do not rely on `left_dbt` alone.
- Ambiguous ASCII-fold names within one relation fail loud.
- Unlock chains such as source → Rename → Append when schema stays known.

### 3. Safe re-export contract (first ship)

Ship **before** H1 parse-back ([ADR-0004](0004-two-way-visual-text.md)). First-release policy:

| Topic | Decision |
|-------|----------|
| Generator-owned files | Listed in an export **manifest** written beside the project (paths relative to export root). |
| Integrity | Store **content hashes** of owned files from the last successful export. |
| Hand-edits | On re-export: if any owned file’s hash ≠ last export → **refuse before writing** (conflict). No silent overwrite. |
| Stale models | Owned paths present in the old manifest but absent from the new plan are **removed only after** the conflict check passes for all retained files. |
| Failure atomicity | Validate the full plan + conflict check **before** any write. A failed export must not leave a partially updated tree. |
| Unowned files | Paths not in the manifest are left untouched. |

**Name stability** (stronger than “identical workspace → trivial diff”):

- Same logical queries/models keep the same file names and `ref()` targets when **focus** changes or an **unrelated** query is added.
- Re-export of a bitwise-identical workspace → empty/trivial diff remains required, but is a **weak** check alone; include focus-change and unrelated-node fixtures.

Offline `dbt parse` stays an author gate only ([ADR-0017](0017-export-offline-dbt-parse.md)). Import into arbitrary existing dbt repos and universal SQL→AST stay **out**.

### 4. Join investigation + explicit expectations → dbt tests

- Diagnostics (counts, unmatched, fan-out, uniqueness samples) scope to **this Join’s inputs after preceding transforms**; open rows in the grid ([DESIGN.md](../DESIGN.md) §9).
- An **expectation** is persisted intentionally; a diagnostic observation does not create it.
- Export corresponding dbt checks (single-column `unique` vs combination-uniqueness for composite keys); survive re-export.
- Deferred: cell-level lineage / universal provenance / rich profiling of every column.
- Expensive checks must not block editing ([ADR-0007](0007-visual-pipeline-editor-killer.md)).

### 5. Build order and external users

```text
step schema → portable emit → re-export contract
  → e2e dbt run + result check
  → Join diagnostics MVP
  → expectation → dbt test
```

**External users run in parallel**, not after the whole stack:

- Recruit and schedule real tasks **while** schema / re-export / e2e are built.
- First external trials are OK after **schema → export → e2e** — do **not** wait for full Join diagnostics or expectation→dbt export.
- Diagnostics and expectations deepen trust; they are not a gate on the first demand probe.

Do not expand the transform catalog ahead of schema, re-export, and e2e correctness.

## Consequences

- [DESIGN.md](../DESIGN.md) §10 is the active DoD checklist; [SPEC.md](../SPEC.md) §7 remains v1 baseline.
- ADR-0004 H1 starts only after this ADR’s acceptance criteria are met (not after baseline export alone).
- Emit helpers (`sql_union_all_aligned`, ASCII fold, ambiguity checks) are the foundation for schema-driven export.
- Positioning promise: assemble and verify on real data; keep SQL/dbt in the user’s infrastructure.
