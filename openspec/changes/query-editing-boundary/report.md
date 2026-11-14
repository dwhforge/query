# Updated-roadmap PR-02 — Query operation boundary

Starting HEAD: `278ff34` (finished PR-01); clean tree before this slice.
Owner authorized both sequential PRs without further confirmation.

## Before / after ownership

Before: App reducer closures called the new pure operations with a Project.
After: App reducer binds `createQueryEditingService(state.project)` and closures
invoke named service methods with typed domain input. No render-captured graph,
QueryContext, setters or panel/tab geometry enter the boundary.

`operations.ts` remains the only graph-rule owner. `service.ts` adds only the
snapshot binding and optional expected target revision. App's PR-01 receipt
effect remains the UI owner of errors/navigation/Preview invalidation.
No Rust, IPC, persisted IR, cancellation, Mapping policy, project store or
execution-controller changes.

## Standalone use

```ts
const editing = createQueryEditingService(project);
const revision = editing.revision("orders");
const result = editing.applyJoin({
  queryId: "orders",
  right: "customers",
  pairs: [{ left: "customer_id", right: "id" }],
  ...(revision === null ? {} : { expectedRevision: revision }),
});
// Validate result.ok, commit result.project, then bind that next snapshot.
// UI may resolve result.navigation using existing semantic navigation.
```

Methods are synchronous and do not perform a commit or acquire data. Multiple
calls on the same service intentionally evaluate the same immutable snapshot;
they are not queued mutations. The reducer binds a fresh service per action.
Revision checking is optional so ordinary batched UI edits retain the current
snapshot semantics. Tokens cover project identity and target Query definition,
not transitive dependencies, warehouse freshness, Mapping contents or UI context.
They are in-process definition fingerprints, not a public transport/security
token. A future adapter must define its own transport/data-redaction boundary.

## Tests

Local evidence: `/tmp/opencode/pr02-query-boundary/`.

- `npm run build`: PASS (`build.log`); existing large-chunk warning.
- `npm run test:unit`: PASS, all **42 files** (`unit.log`).
  New standalone service tests exercise all six stale operations, original
  snapshot preservation, controlled missing/duplicate/invalid targets,
  absent-delete no-op versus stale refusal, project replacement, target-local
  revisions, repeated calls, explicit rebinding, and committed JOIN navigation
  through the existing resolver without React or Electron.
  A final repeat also passed (`unit-final.log`), including a remove-step call
  without any editor selection. Selection hints are optional, not required
  presentation context for a tool operation.
- Full rebuilt Electron: PASS, **70 passed / 2 skipped**, no retries, 4.3 minutes
  (`electron-full.log`). It includes the three
  PR-01 canvas/batching scenarios and the prior flagship/lifecycle/execution/
  tabs/Matching/Inspector coverage; no new test-only mutation hook is needed.
  The second rebuilt run FAILED: **69 passed / 1 failed / 2 skipped**
  (`electron-final.log`), before any graph mutation in the existing flagship
  Mapping-recompute case. Its initial expected `COM-AMM` rows were absent.
  This is retained as failed evidence, not replaced by the earlier green run.
  Ordinary UI callers still supply their existing selection, and final units
  cover omitted selection.
- Rust workspace: NOT RERUN for this TS-only slice. PR-01 immediately preceding
  verification passed 320 tests / 1 ignored; Rust sources remain unchanged.
- Final ordinary production build: PASS (`build-production-final.log`), after
  the final Electron suite, with the existing large-chunk warning.
- Whitespace validation: PASS (`git diff --check`).

## Smoke / limitations / demo verdict

Manual interactive smoke: NOT RUN; no automatic test is represented as a human
pass. Manual recipe: open own disposable project, add/apply/move a step, connect
a canvas JOIN and check selected step, switch Help Lab/Mapping/Matching, Save As
and reopen, then Recompute. Keep Sample and demo/live origin labels visible.

No CLI/MCP/HTTP/Compare adapter, agent-facing Project/QueryContext API, dynamic
registry or plugin runtime is shipped. PR-01 structural-delete/derive/remove-edge
limitations and PR-00 human own-data/packaging/product-metric gaps remain.
Final automated/demo verdict is recorded below.

### Integration ordering follow-up

The flagged test immediately toggled the common Lens control after semantic
navigation, without asserting destination identity, preview completion or Lens
state. It now explicitly waits for the mapped destination's result to exist,
then asserts Lens on → off and Sample scope before checking the same row counts.
The after-edit row assertions, real Mapping Save and Recompute are unchanged.
No automatic Recompute retry, timeout extension, sleep or production execution
guard change is introduced.

A separate deterministic held-preview case verifies that the inspection helper
does not leave Lens while destination preview is pending, releases the existing
test hold, then asserts the same real rows. Failed recomputation captures an
Electron screenshot for diagnostics. This tightens the test's ordering contract;
it is not a claimed causal repair to the product's execution controllers or
every historical timing symptom.

Repeated focused journey: PASS, **22 passed** across two repetitions, including
both held-preview and Mapping-recompute cases (`electron-journey-ordering.log`).
The final full rebuilt suite PASSED: **71 passed / 2 skipped**, no retries,
3.8 minutes (`electron-verified.log`). Both skipped cases require PostgreSQL DSN.
The entry point rebuilt release host and UI, selecting `target/release/dwh-host`;
no stale-host opt-out was used. This run includes the added held-preview case.

## Completion

Merged contract: `openspec/specs/query-editing-boundary/spec.md`. Generated
Inspector screenshots were retained under the local evidence directory and
their tracked originals restored; they are not intentional PR-02 changes.

**Automated baseline: GREEN.** Production UI is rebuilt without E2E hooks.
No human smoke, packaging, independent user trial or release sign-off is claimed.
The prior failed full run and legacy writer-mirror limitations remain recorded;
the final green run is not a claim that every historical timing symptom is fixed.
PR-01 and PR-02 are complete within their stated scope. PR-03+ is not started.
