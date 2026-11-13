# PR-00B delivery report — 2026-11-13

Implemented **PR-00B only**, using the explicitly approved minimal-safe
alternative: live UI retrieval reports unavailable; only explicitly selected,
detached Demo fixtures produce offline sample results. No live success is faked.

## Checkout and scope

The actual checkout began clean at **c74d8a6**, with PR-00A already in HEAD,
rather than the earlier assignment SHA. No PR-00A changes were discarded or
rewritten. No commit, branch or PR was created by this slice.

Reviewed agent/rule requirements, Accepted ADR-0031/0032/0044/0045/0046, merged
Matching/execution/decomposition contracts and PR-00A baseline/report. Recorded
[ADR-0047](../../../docs/adr/0047-matching-demo-live-boundary.md) and the focused
proposal → specs → design → tasks packet before changing runtime code. Completed
requirements are merged into [Matching workspace SoT](../../specs/matching-workspace/spec.md).

## File responsibilities

| File | Responsibility after PR-00B |
|---|---|
| [types](../../../src/app/matching/types.ts) | In-process execution mode; ordinary constructor always defaults to live |
| [execution policy](../../../src/app/matching/executionPolicy.ts) | Detached demo construction, shared live-unavailable copy and demo/fixture write refusal |
| [trial execution](../../../src/app/matching/runTrial.ts) | Explicit demo branch; fixture loader rejects live sessions; missing live plan/input rejects; host errors propagate without fixture fallback |
| [Matching UI](../../../src/components/MatchingWorkspace.tsx) | No unconditional fixture trial; blank rather than sample plan at Mapping entry; persistent data-origin disclosure; demo-only trial and blocked write/review labels |
| [App](../../../src/App.tsx) | Six-line import/callback integration opens a separate demo tab; preserves existing live draft/map/Lens context |
| [persistence](../../../src/app/matching/persistSave.ts) | Refuses demo/fixture data before context reads, planning or writes; includes mode in PR-00A async save revision |
| [trial tests](../../../src/app/matching/runTrial.test.ts) | Live missing/empty/error/cancelled/empty-host behavior, host input forwarding, confirmed-draft retention and reproducible offline demo |
| [persistence tests](../../../src/app/matching/persistSave.test.ts) | Existing save contracts with independent synthetic evidence; origin refusal before dependency calls; mode invalidates save revision |
| [Electron cases](../../../e2e/electron/matching-save.spec.ts) | Four real save-path regressions use independent synthetic evidence; two additional demo/live boundary cases; explicit dirty-state teardown retained |
| [OpenSpec index](../../README.md) and this change packet | ADR linkage, merged contracts, completed tasks and evidence/limits |

## New contracts

- Default live execution never substitutes a fixture plan, candidates or successful
  metrics for a missing plan, missing/empty row inputs, rejected/cancelled host
  call, or empty host result. Failures do not mutate the input draft.
- The ordinary UI does **not** acquire confirmed live row inputs in this slice.
  It visibly reports this limitation both before and after an attempted trial.
- **Demo fixtures** opens a fresh session without target Mapping, Lens context,
  map baseline or original decisions. Entry does not auto-run. Offline trial
  remains deterministic and independent of host/LLM availability.
- Demo origin stays on the session even when proposal provenance changes through
  ranking/review. Demo sessions cannot save even if a target ID is attached.
  Fixture-provenance proposals independently refuse writes in a live session.
- The E2E-only injection hook has no new bypass. Save tests build a single
  synthetic live candidate/proposal, explicitly identified as test evidence,
  rather than importing or relabelling the production demo. Host draft acceptance,
  commit planning, seed persistence, failure/retry and project save/reopen remain
  real. These cases are **not** proof of live Matching retrieval.

## Final validation

| Gate | Result |
|---|---|
| Production build/typecheck | Passed; existing large-chunk warning |
| All frontend units | **33 test files passed**, including PR-00A persistence tests and new trial tests |
| Release host + E2E UI build/typecheck | Passed through the normal Electron entry point; existing native warnings and large-chunk warning |
| Focused Electron | **6 passed (28.5s)** under an isolated virtual display |
| Whitespace validation | Passed |

Focused Electron cases:

1. Missing target map retains the confirmed draft and no success copy.
2. Absent target ID retains the confirmed draft and no success copy.
3. Actual seed write failure stays retryable, including a second failed attempt.
4. Actual local Mapping save, project-file save/reopen, exactly one retained tuple.
5. Live-unavailable attempt preserves the original confirmed session; explicit
   demo opens separately, runs offline and remains non-writing after confirmation
   and test-only attachment to the user's map.
6. Fixture provenance in a live session disables Mapping Save and leaves its map
   unchanged.

An earlier run also passed production build, all 33 unit files and all six focused
Electron cases (14.9s); the final run above includes tightened demo copy and a
stronger failed-rerun/confirmed-decision unit assertion. No failures or interrupted
runs occurred in this slice.

Local raw logs (not repository artifacts):

- `/tmp/dwh-query-pr00b-build-final.log`
- `/tmp/dwh-query-pr00b-unit-final.log`
- `/tmp/dwh-query-pr00b-electron-final.log`

Electron's worker-level host-build skip refers to the release host already
rebuilt by the entry point, not an omitted build. Native unit suites were **not**
rerun; no Rust source changed.

## Preserved contracts

- PR-00A acknowledges only real persistence/verified no-op, keeps failed drafts
  retryable, and does not equate Mapping Save with project-file Save.
- ADR-0031 cancellation/stale ownership and no mutation rollback claim.
- ADR-0032 scenario modules; no general runtime, registry, bus or second store.
- ADR-0044 human confirmation, host materialization/merge gates and no runtime
  Apply or automatic Join change. Demo origin is an application policy, not a
  new host authentication protocol.
- ADR-0045 safe project replacement and ADR-0046 lab assistance untouched.
- No Rust/IPC additions, project IR/version changes, Compare, new row-write
  storage path, preview refactor or Join Lens rewrite.

## Limitations, manual gaps and PR-01 integration

- Live UI row acquisition remains deliberately **unavailable**, not implemented
  or claimed validated. The existing typed retrieval helper is covered with
  injected inputs/results; these units do not prove an end-to-end live query run.
- The demo remains a canned rich review sample, not measured/capped live retrieval
  performance evidence. Optional external LLM ranking and real PostgreSQL were
  not exercised. No human manual/visual/cross-platform smoke or full own-data /
  restart / export journey is claimed.
- The broad Electron suite was not rerun in PR-00B. Its documented baseline is
  33 passed, 2 failed, 2 skipped; the flagship comparison and source-key `to`
  failures are not fixed by this slice. See [PR-00A baseline](../../../docs/stabilization/PR-00A-baseline.md).
- For PR-01 extraction, preserve execution mode through all tab/ref/session
  transformations, retain the shared persistence refusal and save revision,
  and keep demo construction separate from live entry. Do not infer data origin
  from project/query names or Help Lab state, and do not reintroduce fallback on
  exception. Future live acquisition must bind actual rows to the confirmed
  source/target plan and apply the existing stale/project/connection guards.
- Keep negative Electron teardown's explicit test-draft discard; production
  beforeunload still protects unsaved decisions. Ordinary Lens navigation repair
  remains outside this slice.
