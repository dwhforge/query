# Proposal: Safe Help Lab switch

## Status

**Implemented; contract merged into [Help Lab SoT](../../specs/help-lab/spec.md).**
Accepted [ADR-0045](../../../docs/adr/0045-safe-help-lab-switch.md). Product owner approved the replacement model and
required offering Save before closing a project with unsaved work.
Review order: proposal → [delta spec](specs/help-lab/spec.md) →
[design](design.md) → [tasks](tasks.md). Review this updated packet before
runtime implementation. Review and implementation are recorded in [tasks](tasks.md);
actual evidence and limitations are in the [delivery report](report.md).

## Why

The requested save-target isolation changes the original sample-load consequence
in [ADR-0013](../../../docs/adr/0013-project-persistence.md:23), now explicitly
superseded by ADR-0045 following product-owner clarification.
Opening a lab currently replaces content through the existing
[loader](../../../src/App.tsx:2696); [Save](../../../src/App.tsx:3486) uses an
existing saved path. This is source-level risk, not reproduced user data loss.

## Scope

- Reproduce existing lab replacement, cancellation, draft, and Save behavior in
  the existing Electron harness before changing runtime code.
- Save / Discard / Cancel protection for unsaved work, using a reliable saved
  baseline or equivalent dirty signal and explicit save success/cancel outcomes.
- Shared replacement semantics for Help labs, Open, and Open Recent using the
  existing lifecycle path, not a lab-only parallel lifecycle.
- Separate unsaved lab identity and save/export targets, keeping global settings
  and connections and existing advanced-demo presets.
- Protect against failed/stale loads and switches during map writes.
- Regression coverage and factual before/after evidence.

Out of scope: architecture-wide dirty-state infrastructure, unrelated redesign
of project operations, task cards, micro-hints, comparison metrics, presentation changes, new
workspace/Mapping stores, an event bus, Rust engine cosmetics, and cloud services.
Later UX slices remain separate changes after the protection gate.

## Success gate

Cancel preserves the original project and drafts. Save persists the current
project before opening the lab; cancellation or failure keeps the current
project open. Discard opens without saving. A successful switch creates an
independent lab. Saving that lab requires a chosen destination, and must not
implicitly overwrite the previous file. Explicitly saving the working project
before switching may of course update that working file. The
reconciliation flagship loads offline and retains its dirty-join focus.

## Evidence and baseline

- Brief baseline: fd6f1691847a23d793ca8a5a1aa4c06652886eae.
- Inspected branch: feature/matching at bd61e2b4a90d2efa482fd4462a896df535a4af89.
- Branch comparison: two Matching files differ from the brief baseline:
  [semantic expansion](../../../src/app/matching/semanticExpand.ts) and
  [Matching workspace](../../../src/components/MatchingWorkspace.tsx).
- Pre-fix reproduction, actual screenshots and final validation are recorded in
  the [delivery report](report.md). Broader suite failures are not marked passed.
