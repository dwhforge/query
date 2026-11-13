# PR-04 report — execution confidence pass

Baseline: PR-03 commit a5aeebb. No engine, fixture or project IR changes.

## Reproduce → fix → objective check

| Audit item | Before / actual reproducer | After / regression |
|---|---|---|
| Query/Data agreement | With the next real preview held, selecting another query still showed two old rows | Current-input snapshot gates result rendering; pending selection shows no old rows |
| Cancel | Held request kept local running/result state; no terminal cancelled explanation | Cancel clears timeout, invalidates generation and shows cancelled; late reply ignored; Recompute works |
| Error | Actual missing CSV error left Data in ambiguous waiting state | Existing ErrorBanner plus explicit failed state and retry |
| Empty | Filter false produced no clear empty-result message | Existing PreviewTable states that no rows were returned |
| Sample/full | Heavy query without Join had no Load full action because of the shared Lens flag | Actual visible Lens, not the flag alone, determines action availability; full/sample/reset checked |
| Late reply | Deterministic one-shot preview hold tests older versus newer input | Releasing older preview cannot replace the newer result |
| Mapping recompute | Flagship map intentionally lacks the ammonia correspondence | Existing editor Add row/Save plus Recompute produces AMM-A rows where COM-AMM had remained; no full-success claim |
| Step/scope | Data chrome previously named only the query | Chrome labels final output versus through selected Join; Model is labelled final model; selected History step exposes aria-current |
| Save/reopen | Covered by PR-01 real-file checks | Final safety suite remains part of combined validation |

The initial three UI reproducers failed before runtime changes. Two additional
empty/full-control reproducers also failed before their local fixes. One-shot
test holds are gated by the existing E2E build flag and still invoke the real
Rust host; there are no production mocks or delays.

## Implementation boundary

The result owns a reference to the immutable input snapshot, connections, sources
and project-file context already used for that request, not another editable
workspace. A cancelable effect timeout replaces the unowned debounce; the existing
request-generation guard covers host and cache paths. Authoring changes and
explicit Recompute clear the session cache. No new compiler/hash/event system.

## Actual validation and evidence

- UI/host build passed in the Electron runner; all 31 unit-test files passed.
- 16/16 focused execution + flagship Electron scenarios passed after the fixes.
- Includes normal workspace, offline flagship, sample/full, cancel/error retry,
  late replies, hints, target navigation and an actual Mapping edit/recompute.
- [Stale rows before](../../../docs/stabilization/execution-pending-before.png)
  → [pending state after](../../../docs/stabilization/execution-pending-after.png).
- [Ambiguous error before](../../../docs/stabilization/execution-error-before.png)
  → [explicit error after](../../../docs/stabilization/execution-error-after.png).
- [Actual offline No match evidence](../../../docs/stabilization/flagship-join-lens.png).
- Contract merged into [execution lifecycle](../../specs/execution-lifecycle/spec.md).

No screen recording, real PostgreSQL run, full-input reconciliation assertion,
cross-platform visual pass, held Model IPC scenario or human usability session
is claimed. Model selection/final-output labels and normal navigation were
observed, but this is a focused audit rather than a redesign or exhaustive UI proof.
Broader pre-existing suite failures remain in the PR-01 report and final batch report.
