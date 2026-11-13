# Design: Safe Help Lab switch

## Decision gate

[ADR-0045](../../../docs/adr/0045-safe-help-lab-switch.md) is Accepted following
product-owner clarification and explicitly supersedes the old sample-path
consequence in [ADR-0013](../../../docs/adr/0013-project-persistence.md:23).
This packet was reviewed in proposal → spec → design → tasks order. Implementation
is delivered; exact validation and remaining coverage gaps are in the
[delivery report](report.md).

## Existing paths and evidence boundary

The [demo loader](../../../src/App.tsx:2696) asks about Matching decisions before
loading, then builds project state from the previous project. It clears editor
tabs after success. [Save](../../../src/App.tsx:3486) uses the current path when
present. [Save As](../../../src/App.tsx:3500) already handles fork identity.
These observations inform tests; they do not replace an interactive reproducer.

## Proposed minimal implementation

1. Audit existing project constructors, global connection merge, Mapping draft
   signals, write-in-flight signals, and project transition guards. Record
   differences between demo, Open, Open Recent, and New. Do not assume a common
   reliable dirty indicator exists.
2. Use one local project-replacement guard for Help Lab, quick-load demos, Open,
   and Open Recent. Track a saved baseline or use an existing reliable dirty
   signal; reset it only after successful load/save. Distinguish unsaved file
   state from separate Mapping/Matching drafts. Exclude app-global settings and
   ephemeral preview state from project dirty comparisons. Do not infer clean
   state from the presence of a save path.
3. When work is unsaved, present Save / Discard / Cancel through a small existing
   dialog pattern, not two binary browser confirmations. Save must return an
   explicit success/cancel/failure outcome; the existing write helper catches
   errors, so awaiting it alone is not proof of persistence. A cancelled picker
   or failed save prevents replacement. If separate drafts cannot be saved
   through existing tools, keep the project open and explain the remaining work;
   do not auto-accept proposals or silently write warehouse rows. Reuse existing
   draft-save capabilities where safe rather than inventing a second save store.
4. After permission and any requested save, load and stage an ordinary project using existing constructor/migration
   helpers rather than selectively deleting a growing list of previous fields.
   Retain global connections/settings only through their existing merge path.
   Reuse the existing UID mechanism, not a new identity format.
5. Commit project and navigation only after successful loading and validation
   that the request is still current. Reuse existing revision/request guards.
   Clear previous project-local drafts only when committing replacement. Block
   or settle map writes first. No automatic rollback claim for warehouse writes.
6. Keep lab focus/navigation and advanced routing behavior. Set explicit offline
   DuckDB routing for the reconciliation flagship instead of inheriting a remote
   default. Reset save/export linkage and project-specific state by construction.
7. Saving the newly opened lab follows the ordinary unsaved-project picker. After Save, existing path
   relativization and identity contracts remain responsible for persistence.
   The previous project's successful save is not rolled back if lab loading
   subsequently fails; leave that saved project open and report the load error.

## Required evidence

Use the existing Electron harness, temporary project files, and file-byte
comparison, not a mock-only assertion that a dialog opened. Cover new unsaved and
saved projects, query/step/KeyMap edits, Mapping drafts, Matching decisions,
Cancel, failure, repeated requests, write-in-flight, and Save/reopen.

Capture real before/after screenshots when an Electron session is available.
Record blocked environments explicitly. No screenshot asset, metric, or test
result may be invented. Keep the implementation local; if satisfying these
requirements needs broader persistence architecture, return that scope for
review rather than expanding this change silently.
