# ADR-0045 — Safe project replacement when opening Help labs

## Status

**Accepted** (2026-11-13), following explicit product-owner clarification:
opening any Help lab replaces the current project as opening another project
would; offer to save unsaved work before closing it and opening a clean lab.

Supersedes **only** the sample-load saved-path consequence in
[ADR-0013](0013-project-persistence.md:23). Implemented in PR-01; validation and
known suite failures are recorded in the [delivery report](../../openspec/changes/safe-help-lab-switch/report.md).

OpenSpec review packet: [safe-help-lab-switch](../../openspec/changes/safe-help-lab-switch/proposal.md).

## Context

The immediate UX brief asks that opening a Help lab cannot silently discard work
or make a subsequent Save overwrite the previous working project. The initial
brief was a proposal; the subsequent product-owner clarification approves the
project-replacement model and requires offering Save before switching.

[ADR-0013](0013-project-persistence.md:23) explicitly says sample loading preserves
an explicit saved path. [ADR-0025](0025-project-references.md:27) separately defines
project identity, new projects, and forks. Connections are app-global, not demo
content. [ADR-0039](0039-help-lab-catalog.md) makes labs ordinary workspaces using
the existing demo loader.

Source inspection finds that the [demo loader](../../src/App.tsx:2696) replaces
workspace content while spreading the previous project, and
[Save](../../src/App.tsx:3486) uses the current saved path without a picker when
one exists. The loader's initial confirmation addresses Matching decisions only.
Pre-fix Electron reproduction subsequently confirmed replacement without a
warning and retention of the old save path. No real user file was overwritten;
the reproduction used an isolated temporary project. See the delivery report.

## Decision

1. Opening any Help lab or quick-load demo is a **new, unsaved project**, not
   an edit to the current saved project. Keep the existing demo-loading route;
   do not introduce a workspace store or another editor.
2. Treat lab opening as the same project-replacement operation as opening an
   existing project. When the current project has unsaved work, offer
   **Save / Discard / Cancel** before replacement. An edited project with an
   existing file is still unsaved work; having a path is not a clean-state test.
   An unmodified saved project needs no warning. Initial empty startup needs no
   warning. Use a saved baseline or equivalent reliable existing dirty signal;
   do not silently substitute a discard-only prompt for the required Save option.
3. **Save** saves the current project, asking for a path if it has none, and
   permits replacement only after confirmed successful persistence. Picker
   cancellation or any save failure leaves the current project and drafts open.
   **Discard** explicitly permits losing the unsaved work. **Cancel** abandons
   the switch. Project-file Save must not be represented as saving separate
   Mapping/Matching drafts: if those cannot safely be saved through existing
   tools, keep the current project open and explain what still needs saving.
   Do not silently commit warehouse writes or accept Matching proposals.
4. Cancel changes no project content, local drafts, tabs, selection, saved path,
   or identity. A rejected or failed lab load does not commit replacement state.
   If the user successfully saved before a later load failure, that save remains
   successful and the saved current project stays open; it is not rolled back.
5. A successful switch receives a new project identity using existing identity
   creation conventions, a demo name, and no previous save target or linked dbt
   export tree. Previous references, connection bindings, outputs, mapping checks,
   and check history must not leak into the new project. Lab-defined content is
   initialized through existing constructors and migration helpers.
6. Keep app-global connections and settings. Do not inherit the old project's
   destination or export location. Respect existing explicit engine/destination
   presets for advanced demos; the offline reconciliation lab uses DuckDB even
   when the user's default engine is PostgreSQL.
7. Save after switching asks for a destination. This prevents **implicit** reuse
   of the old save target; it does not forbid an explicit user-selected overwrite
   through the existing file dialog.
8. Consolidate the Matching draft warning into the replacement confirmation, not
   two successive warnings. A write already in flight must settle or block the
   switch; cancellation of a UI operation cannot undo committed map writes.

## Alternatives

- **Keep ADR-0013 unchanged:** compatible today, but Save can still target the
  previous project after opening a lab. This does not meet the proposed gate.
- **Only add a warning:** protects against unnoticed replacement but does not
  isolate identity or the save/export target.
- **Introduce global dirty tracking or Save/Discard/Cancel now:** larger than
  necessary and risks implying that project Save persists warehouse drafts.

## Consequences and implementation gate

This explicitly changes the old persistence consequence with product-owner
approval. Apply the same save-before-replacement semantics to user-initiated
Open and Open Recent through the existing project transition path; labs must not
be a second lifecycle implementation. Audit other replacement paths, including
New if present, before expanding their implementation scope. Startup restoration
is not a request to discard a working project. No Rust engine change is planned
for UI policy. Review the updated OpenSpec packet before runtime implementation.

The implementation uses the existing project model and host commands. Merged
capability contract: [Help Lab](../../openspec/specs/help-lab/spec.md). The delivery
report distinguishes Electron/unit evidence from unexercised manual paths and
the failures in the broader test suites.
