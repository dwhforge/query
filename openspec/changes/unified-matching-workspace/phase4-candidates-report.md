# Phase 4 — Join Lens No match RIGHT Candidates

Status: **read-only Lens Candidates implemented and verified**. The parent change
remains in flight. No commit, spec merge, archival or full-change completion.

Decision: [ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md).
Read the agent rules, ADR, proposal/deltas/design/tasks and both
[Basic](phase2-basic-report.md) and [Advanced](phase3-advanced-report.md) reports.

## Actual checkout and preservation

The user supplied baseline `30ead1dfd6e30b76865ca19d7b7d696134a4db18` with phases
1–3 described as uncommitted. Initial checks instead returned **clean working
tree**, HEAD **`5820b99aad33f31c52927a323ee9daa51b79d2d5`**, subject “Phase 3 Advanced
LIVE integration for the Unified Matching Workspace is implemented and verified
end-to-end in the working tree.” Work proceeded on that actual checkout; no reset,
checkout, stash, commit or replacement of prior implementation was performed.
Historical phase reports are retained, not rewritten to claim a different baseline.

No changes to [App](../../../src/App.tsx),
[MatchingWorkspace](../../../src/components/MatchingWorkspace.tsx),
[FindRightDialog](../../../src/components/FindRightDialog.tsx), Host, engine,
bridge, persisted format or merged capability specs. The legacy
[JoinLensAuto source](../../../src/components/JoinLensAuto.tsx) and its direct
component tests remain intact and unmounted from Lens, including callback-free
Lens callers. No broad App refactor or new matching engine.

## Delivered behavior

- RIGHT shows **No match / Candidates** only inside Lens **No match**. The normal
  unmatched-right diagnostics, filter, Suggest and explicit mapping workflow remain
  under No match. All rows has no selector. One Find Matches action routes into
  existing Matching; obsolete contextual hint and inline batch fallback mount removed.
- Source selection follows the existing full-tuple Suggest source: selected LEFT
  diagnostic card first, otherwise active unmatched ordinary result. Candidate
  inspection additionally requires every source key column to exist. Right-only
  and hypothetical pair selections are not sources. No splitting/normalizing scalar
  display labels. NULL, empty, significant spaces, literal NULL/∅ and delimiters
  retain their exact nullable-string array identities. NULL-only tuples stay exact.
- Focused retrieval uses exactly the existing path:
  `joinKeyFuzzySuggest(workspace, hostQueryId, joinStepIndex, connections, sources,
  null, null, projectRef, { source_parts: sourceParts })`.
  No new RPC, engine, scorer, LLM/config call, batch run or Mapping write path.
- Up to eight complete actual RIGHT tuples, ordered by Host score (unknown last),
  all ordered output fields, mean score and metric label, occurrences/duplicates,
  expandable field-by-field source→target values/differences/scores. No independent
  per-field target synthesis and no renderer scoring. Below-cutoff results remain
  inspectable; a cutoff does not silently discard the requested Top-K.
- Shows retrieved/total right tuple counts, total rows, displayed/returned
  competitors, source occurrences, incomplete/bounded scope, unknown field scores,
  source-unavailable/empty/refused/error states. Even complete retrieved coverage is
  labelled Top-K, not an accepted match or dataset-wide best-match guarantee.
- First opening lazily queries the current tuple. A new tuple while open never
  prefetches: exact cache hit or explicit **Find candidates**. Reopening an uncached
  tuple can query again. No unbounded prefetch.
- Sixteen-result LRU, tuple JSON-array keys, local definition/session context.
  Project identity, enabled session/entry nonces, workspace, connections, sources,
  references, host JOIN index/keys/right query invalidate. Context changes discard
  the entire cache, including context ABA. Late selection/context/visibility/unmount
  replies cannot enter the cache or UI. Loading/errors carry request generations too.
- Candidate inspection has no target radio, accept, confirmation, decision store,
  LLM action or write authority. Suggest remains a separate existing button/modal
  with independent retrieval and existing explicit confirmation/Apply workflow.

## Exact verification commands and results

Linux `/bin/sh`; browser suites used the installed pinned Chromium (no override,
dependency install or browser download). Electron uses Xvfb and actual release
Host plus real temporary CSVs/DuckDB. Native tests ran serially.

| Command | Observed result |
|---|---|
| `git rev-parse HEAD` / `git status --short` | Actual starting HEAD above; clean initial tree |
| `npx tsc --noEmit` | Final pass; first pass failed on now-unused Lens callback destructuring after removing inline batch; removed that unused destructure, retained compatibility prop type |
| `npm run test:unit` | 49 test files passed; rerun after final production build |
| `npx playwright test -c src/components/JoinLensCandidates.playwright.config.ts` | Final **22 passed (29.8s)** |
| `npx playwright test -c src/components/FindRightDialog.playwright.config.ts` | **13 passed (9.2s)**; existing modal suite unchanged |
| `npx playwright test -c src/components/MatchingWorkspace.playwright.config.ts` | **9 passed (9.2s)**; Basic/Advanced review regression |
| `cargo test -p dwh-host --test join_tuple_suggest --test join_tuple_lifecycle --test matching_advanced_join -- --test-threads=1` | **18 passed**: 2 tuple wire/verification, 6 tuple persistence, 10 Advanced acquisition/verification |
| `xvfb-run -a node scripts/run-electron-e2e.mjs join-tuple-save join-batch-save matching-advanced matching-save` | Fresh release Host + E2E UI build; **17 passed (2.3m)**, including all five Candidate→Suggest→Mapping/Apply/Save/cold-reopen cases |
| `DWH_E2E_SKIP_HOST_BUILD=1 DWH_E2E_SKIP_UI_BUILD=1 xvfb-run -a node scripts/run-electron-e2e.mjs join-candidates` | **1 passed (4.3s)** against the preceding fresh binaries; actual already-joined RIGHT target with zero unmatched-right rows |
| `xvfb-run -a node scripts/run-electron-e2e.mjs join-candidates join-tuple-save join-batch-save matching-advanced matching-save` | Rebuilt final production source as E2E UI and release Host: **17 passed, 1 failed (2.7m)**; failure was the 5-key test's cold-reopen preview call, after candidate inspection, modal/Mapping/Apply, execution and Save had passed |
| `DWH_E2E_SKIP_HOST_BUILD=1 DWH_E2E_SKIP_UI_BUILD=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test -c playwright.config.ts e2e/electron/join-tuple-save.spec.ts --grep '5-key'` | **1 passed (7.9s)** on exact same final binaries, no product/test change or retry policy added |
| `npm run build` | Final production build passed; existing >500 kB Vite chunk warning only; done after Electron checks so dist ends as non-E2E production build |
| `git diff --check` | Passed |
| `git diff --exit-code -- src/components/FindRightDialog.tsx src/App.tsx src/components/MatchingWorkspace.tsx src/components/JoinLensAuto.tsx openspec/specs` | Passed: those areas unchanged relative to actual starting HEAD |

The wrapper explicitly built release Host before Electron and logged
`target/release/dwh-host`; no portable/stale Host override. Skip-build commands
reuse that verified build, not the supplied old baseline. The wrapper build includes
TypeScript checking and E2E-enabled UI compilation. No final all-green 18-case run
is claimed: the full run and targeted recovery are reported separately.

### What the tests prove

Browser tests mount the actual Lens and real bridge wrapper over a controlled
Host double; they do not substitute a candidate component or its cache logic.
They cover 1–5 ordered tuples, same-first-key distinct full sources, no eager fetch,
Top-8 order/below-cutoff data, NULL/string/delimiter identities, 16-entry LRU eviction
and hit touching, tuple and project ABA, delayed/out-of-order replies, late errors,
project/connection/workspace/reference/source/JOIN/session invalidation, unknown
scores, incomplete/complete/empty/source-unavailable/error replies, right-only/pair
refusal, no writes or LLM, independent Suggest modal and one Matching entry.

Five real Electron tuple cases now inspect Candidates **before** the existing
Suggest modal, verify the full output fields/order and field differences, compare
project workspace bytes before/after inspection, toggle diagnostics back and forth,
then continue the existing explicit Mapping→Apply→execute→Save→cold-reopen journey.

The additional real Electron case has one unmatched LEFT alias, another LEFT row
already equal to the only RIGHT tuple, and physical RIGHT column order reversed.
Real diagnostics return zero unmatched RIGHT rows; Candidates nevertheless returns
the real full target. It checks coverage 1/1, exact source/target fields and ordered
differences, no project mutation, then opens/closes the unchanged Suggest modal
without selecting or writing and retains the candidate view. Nothing mocks Host.

Basic/Advanced real loopback-provider and Save/cold-reopen regressions retain the
preceding milestones. These are not new paid-provider or connector claims.

## Failures found, fixes, and limitations

1. Initial Candidates browser run: **13 passed / 4 failed**. One real bug: selection
   A→B→A rejected old result data but could revive A's old loading state. Fixed by
   binding loading/error state to monotonically increasing request generation, not
   value ownership alone. Final tests separately cover source and project ABA.
   Other failures were test-double errors (incomplete fake Mapping shape and absent
   source dereference) and the test overlooking the intentionally lazy auto-fetch
   when re-entering No match after JOIN identity reset. Corrected fixtures/assertions.
2. Expanded browser run: **20 passed / 1 failed** because the Host double wrote to
   its now-empty target universe. Guarded that fixture mutation; final 22 pass.
3. Final full Electron run's cold-reopen failure surfaced only a generic Error from
   the existing `joinedRows` helper when a raw preview reply was not successful.
   Trace places it at the final cold-reopen preview, not at Candidates retrieval or
   a write. The historical report records a preview-supersession flake at this same
   boundary, but **this run did not retain a specific Host error**, so identical root
   cause is not proven. Targeted unchanged 5-key rerun passed. No broad App/lifecycle
   patch, generic retry or hidden test skip was introduced.
4. Read-only Lens inspection is **not** the outstanding shared Matching manual
   candidate/verified-extra-lookup/ledger acceptance feature. Existing unchecked
   tasks for that wider capability remain unchecked. No out-of-shortlist Advanced
   acceptance or new commit route is claimed.
5. Freshness is local definitions/session only. External CSV/database edits in place
   are not detected by LRU/fingerprints; existing Host preparation semantics remain.
   Explicit Find candidates asks Host again, not guaranteed external snapshot refresh.
6. Browser race tests use delayed controlled replies; there is no dedicated Electron
   rapid-selection/ABA injection test. Electron validates real data/Host/UI and
   no-write boundaries, while race/cache interleavings are covered in the browser.
7. Native parallel SIGSEGV remains unresolved; serial green is not parallel green.
   Paid provider, PostgreSQL, Parquet and connector-scale Candidate tests were not
   run. Existing parent adversarial write/Save interleavings remain parent work.
8. Parent cleanup owns final obsolete source/test removal, cross-reference/help
   reconciliation, acceptance, full change completion and merged capability specs.

## File inventory

| File | Scope |
|---|---|
| [JoinLens](../../../src/components/JoinLens.tsx) | Narrow right-panel slots/selector/source wiring; remove inline batch mounting and obsolete contextual hint; modal unchanged |
| [JoinLensCandidates](../../../src/components/JoinLensCandidates.tsx) | Read-only existing-RPC retrieval, exact context/tuple/generation guards, bounded LRU, evidence rendering |
| [Browser spec](../../../src/components/JoinLensCandidates.ui.spec.ts) / [config](../../../src/components/JoinLensCandidates.playwright.config.ts) | 22 real-Lens component browser checks |
| [Tuple Electron journey](../../../e2e/electron/join-tuple-save.spec.ts) | Add Candidates prelude; retain original modal/Mapping/Apply/Save/cold-reopen checks |
| [Candidate Electron journey](../../../e2e/electron/join-candidates.spec.ts) | Real already-joined RIGHT target despite zero unmatched-right rows, no writes and independent modal |
| [Proposal](proposal.md), [Lens delta](specs/join-lens-no-match/spec.md), [design](design.md), [tasks](tasks.md), this report | In-flight scope/contract/evidence only; no merged spec edits |
