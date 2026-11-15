# Development notes — immediate UX batch

## Unified Matching Workspace — 2026-11-15 (development checkout)

- One existing Matching tab now owns full-tuple Fuzzy/LLM and contextual live
  plan review, alternatives, conservative/reviewed bulk acceptance and undo.
- JOIN-bound Write Mapping reuses atomic Mapping + Apply with original-JOIN
  ownership, Host verification, acknowledged receipts and explicit refresh.
- No match RIGHT offers read-only lazy Candidates; Suggest Right remains modal.
- Real CSV/DuckDB Electron Save/Reopen is verified for Basic 1–5 keys and
  Advanced extra-field constraints. This is not a new published package.
- Bounded inputs, unsupported Advanced scopes/NULL fields, no durable draft
  restoration and stateless external-data verification remain limitations.
  Full evidence and unverified cases: [report](../openspec/changes/unified-matching-workspace/report.md).

## Unreleased development checkout — 2026-11-13

These notes describe the reviewed **feature/matching** checkout, not a declaration
that a new release has been published. The remote default branch was confirmed
as **main**, at fd6f169 when this batch was implemented. Existing release tags
and packages can predate these commits. Select a release's own source tag when
you need source/package parity; no direct new-package download is invented here.

### Available in this checkout

- Safe Help Lab/Open/Recent project replacement with Save / Discard / Cancel;
  labs do not inherit the previous identity, save path or linked export tree.
- An English, dismissible task in the offline Shipments ↔ sales lab, with
  explicit original / prepared example / monthly comparison navigation.
- Opt-in two-goal Join → No match hints; Got it/Dismiss/Escape and project cleanup.
  No generic guidance, timer, modal tour, automatic map edit or cloud call.
- Current-input preview ownership, clear running/cancelled/error/empty states,
  Recompute, sample/full labels and final-output/selected-Join scope.
- Existing Mapping tools can extend the partial lab map; the real Electron
  exercise adds COM-AMM → AMM-A and recomputes actual example rows.

### Not claimed

- A completed general Join Debugger, automatic data repair, correctness KPI,
  full-input reconciliation, a durable Matching session, or arbitrary dbt import.
- LLM access is not required by this flagship. Optional contextual/LLM Matching
  is a separate limited workflow, not a hidden dependency of offline preview.
- A clean-machine Windows/macOS validation or published package containing this
  batch. Linux Electron UI/host behavior was exercised; CI defines package targets.
- All repository suites being green. Known broader failures are recorded in
  [PR-01 evidence](../openspec/changes/safe-help-lab-switch/report.md) and subsequent
  [batch report](stabilization/UX_IMPACT_REPORT.md), rather than hidden inside UX changes.

### Evidence

[Actual flagship No match](stabilization/flagship-join-lens.png) ·
[Task card](stabilization/recon-task-card.png) ·
[Opt-in hint](stabilization/recon-no-match-hint.png) ·
[Preview error state](stabilization/execution-error-after.png)

The screenshots are from running Electron builds. No synthetic success state,
video recording or human comprehension study is claimed. Licensing is unchanged:
[BSL 1.1, source-available](../LICENSE), with the Additional Use Grant and conversion
terms in the license; it is not an OSI open-source license today.
