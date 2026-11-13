# PR-04A delivery report — Query preview controller

## Live baseline and preservation

Initial HEAD was **8d00ead29d7ce8dd93296a9ac3fbec029456f4fb** (PR-01), with
PR-02/03, stable Mapping Save API registration and an unrelated ignore-file edit
already staged. An external commit landed during this task:
**87b97353f1ede5dd402d861ab6d08414a9215526**, titled “PR03 goal: ephemeral
QueryContext and small explicit shared semantic commands”, parented by the initial
HEAD. It includes that pre-existing work and the ignore-file edit. Final staged
diff is empty. This task did not stage, reset, checkout, write the index or commit.
No external work was reverted. No Rust, host/IPC, dependency or persisted-IR files
changed. The existing release host was reused explicitly, not rebuilt.

Read AGENTS, the always-applied ADR/OpenSpec rule, Accepted ADR-0031/0032/0041/
0044/0045/0046/0047, relevant merged execution/decomposition/preview/navigation/
project/Matching contracts and the PR-03 report handoff from line 188. Recorded
and reviewed proposal → specs → design → tasks before runtime. No new product
decision or ADR. Delivered requirements are merged into
[Query preview SoT](../../specs/query-preview/spec.md).

## Before / after responsibilities

Before, [App](../../../src/App.tsx) owned the result/snapshot/phase/mode/loading
states, timer, generation, heavy cache, input-reset/cache effects, full async
runPreview body, debounce, quality-tab preemption and refresh/cancel policy.
ProjectSessionReset reached into six separate preview invalidation/state ports.

| Owner after extraction | Exact responsibility |
|---|---|
| [Controller](../../../src/app/queryPreview/controller.ts:44) (152 lines) | Entire Query Data request lifecycle: immutable result/input snapshot, phase/loading, existing requestGen, cancellable 150 ms debounce, heavy cache ownership/invalidation, sample/full run, transport trimming, error/cancel classification, repeated refresh, local/host cancel, analysis preemption and replacement reset |
| [Hook](../../../src/app/queryPreview/useQueryPreview.ts:7) (50 lines) | Stable controller construction, current-input/error refs, subscription, React scheduling/cleanup and quality-tab host cancellation; render-time snapshot matching; explicit selection signal for post-render sample requests |
| [App preview adapter](../../../src/App.tsx:1111) | Supplies project, existing scoped workspace, availability/surface and one client-error callback; renders the returned view and calls narrow actions. No preview state setters, generation, timer, cache or async orchestration remain in App |
| [Selection adapter](../../../src/App.tsx:1605) | Synchronous preview invalidation before semantic selection; same-target selection requests a fresh post-render sample without making QueryContext an execution scheduler |
| [Replacement adapter](../../../src/App.tsx:3375) / [session reset](../../../src/app/projectSessionReset.ts:40) | Calls one resetPreview port exactly once on committed replacement; the adapter also retains the existing separate diagnostic session-generation advance |
| [App scope construction](../../../src/App.tsx:1018) | Retains selected-query/focus fallback, through-selected-Join workspace construction and Mapping-quality inspection exception |
| App non-preview owners | Model SQL preview, Join column inference, prepare/status/diagnostics, diagnostic sample view and numeric progress polling, check/remap handoffs, Mapping/Matching drafts and persistence remain where they were |

Tracked App diff against final external HEAD: **21 added / 195 removed** (net
174 fewer lines). This is a scenario extraction, not a line-count-only split.
The controller uses four effect/read ports, not a setter bag. The hook has five
input/effect options and returns view state plus narrow owner actions.

## Preserved contracts

- Existing requestGen and host cancel infrastructure remain authoritative. Both
  generation and current-input checks reject late success/error/loading completion,
  including the render/effect gap. Cache hits also advance the request generation.
- Auto-preview remains structural DuckDB sample LIMIT 50, including heavy focuses.
  Explicit full uses the existing flag and a distinct previewTransport cache key.
  Required seed maps retain full entries; unused map entries are transport-only
  stripped. No authoring map is truncated.
- Recompute cancels pending debounce, clears the session cache and repeats the
  current mode. Repeated/overlapping refreshes are newest-wins. Workspace, source,
  connection, path and project changes invalidate cache; reference/binding/engine
  owner changes are also conservatively invalidated.
- Explicit navigation invalidates synchronously and supplies a preview-owned
  post-render request signal. QueryContext is not a scheduler dependency. Ordinary
  input/availability changes schedule through the hook, using the existing scoped
  workspace rather than another selection/hydration implementation.
- Prepare/diagnostics retain their host cancellation and call preview preemption,
  which also drops a pending debounce. The Query owner never resets a Mapping or
  Matching session. Replacement alone invokes the reset adapter.
- Client errors still use the existing query-error banner adapter. The separate
  lifecycle-error state/controller is untouched and retains priority; successful
  preview cannot clear a project persistence/load error.
- Typed tabs and semantic selection, captured original-JOIN targets, central
  diagnostic context resets, stable Mapping Save API registration/current callback
  dispatch, demo non-write, live-unavailable and acknowledged Save remain intact.
  No Join Lens rewrite, Compare service or universal DuckDB abstraction.

## Tests and exact checks

### Deterministic behavioral units

[Controller tests](../../../src/app/queryPreview/controller.test.ts) use deferred
promises and an injected clock, not real-time sleeps. Cover fast query/step-scope
changes, replaced debounce, stale success/error/loading completion, render/effect
gap, exact-input ABA, explicit same-target re-entry, host + local cancel, cleanup,
error/empty/cancel terminal states, required/unused map transport, separate sample/
full caches, cache-hit supersession, repeated/overlapping refresh and project reset.
Cache edits include a map row outside the cheap fingerprint samples (asserting
the key itself is unchanged), connections, sources, path, UID, references and
bindings. [Session-reset tests](../../../src/app/projectSessionReset.test.ts)
assert the single reset call and preserve all other owner resets.

One intermediate build failed because the new test fixtures used the wrong
PreviewResult shape. Corrected the fixtures; final typecheck/build and all units
pass. The unit runner bundles/transpiles; the production build also typechecks.

| Final check | Actual result / log |
|---|---|
| npm run test:unit | **38 files passed**, `/tmp/pr04a-units-final.log` |
| npm run build | **Passed**, final non-E2E build `/tmp/pr04a-build-final.log`; existing >500 kB chunk advisory remains |
| Focused Electron execution/navigation/lifecycle/tabs/Matching | **40 passed (3.3m)**, `/tmp/pr04a-electron.log` |
| Flagship Help Lab journeys | **10 passed (1.3m)**, `/tmp/pr04a-lab-journey.log` |
| git diff --check | Passed |

Electron command (existing release host, fresh E2E renderer build):

```sh
DWH_E2E_SKIP_HOST_BUILD=1 xvfb-run -a npm run test:e2e:electron -- \
  e2e/electron/execution-states.spec.ts e2e/electron/query-navigation.spec.ts \
  e2e/electron/help-lab-switch.spec.ts e2e/electron/workspace-tabs.spec.ts \
  e2e/electron/matching-save.spec.ts
```

Breakdown: execution **9**, lifecycle **13**, Matching Save **6**, navigation **7**,
tabs **5**. Three new execution cases exercise held stale error, same-target
semantic re-entry plus repeated Recompute, and held preview tab ABA. Existing
navigation cases exercise original-JOIN return, retained dirty drafts, unavailable
targets, keyboard hydration, late diagnostic samples and same-target restoration.
Matching dirty teardown retains the explicit test-only discard after assertions;
no product beforeunload guard was weakened.

The additional Help Lab command reused the same E2E renderer (runtime unchanged):

```sh
DWH_E2E_SKIP_HOST_BUILD=1 DWH_E2E_SKIP_UI_BUILD=1 xvfb-run -a \
  npm run test:e2e:electron -- e2e/electron/help-lab-journey.spec.ts
```

Final production build ran after Electron, leaving a non-E2E distribution. Total
focused evidence is **50 passing Electron cases**, not a whole-suite green claim.

## Limits and manual gaps

- Broad baseline **33 pass / 2 fail / 2 skip** is carried forward as historical
  evidence, not rerun or declared repaired here. The known unrelated mapping-create
  case 6 (source key `to`) remains for the separate final task. This slice did not
  run mapping-create at all; it does not claim the earlier 52-case selection or a
  single-case regex exclusion as its own result.
- Query preview has phase/loading progress, not a numeric host progress stream.
  Stale phase/loading completion is explicitly unit-tested. Numeric Join progress
  stays in App for PR-04B; existing navigation tests exercise late diagnostic
  samples, not a new deterministically delayed numeric progress reply.
- No new screenshots, manual desktop session, live warehouse retrieval, external
  LLM, PostgreSQL mutation or durable Matching session coverage is claimed. Matching
  Save tests retain their explicit synthetic live-evidence boundary.
- Full loading here proves existing frontend/host sample/full behavior, not
  full-input reconciliation correctness or performance on large warehouses.
- No Rust tests were run: Rust and IPC were unchanged and the logged release host
  path was target/release/dwh-host, with no portable-host precedence.

## PR-04B handoff — not implemented here

1. Extract Join prepare/status/diagnostics and their numeric progress by scenario,
   retaining existing QueryContext and project-session stale guards. Add explicit
   held numeric-progress evidence (including pending poll completion after cleanup)
   rather than treating the preview loading tests as that coverage.
2. Use previewController.preempt when analysis takes the lane. It invalidates local
   generations and pending debounce without cancelling another owner's host work;
   the analysis owner retains its existing explicit cancel call. Use cancel only
   for user/quality ownership interruption, reset only for committed replacement.
3. Keep dataWorkspace scope construction and diagnostic sample view distinct. Do
   not use QueryContext revision to schedule preview, add a second host lane or
   move Join Lens internals/Compare into this controller.
4. Preserve original-JOIN structural targets, typed navigation, stable mounted
   Mapping registration/current callbacks, and separate Mapping/Matching reset/
   draft/Save authority. Re-verify live HEAD and status before editing; external
   commits happened during this task.
5. Carry the broad baseline and mapping-create case 6 separately. Do not rerun the
   entire suite merely to claim this slice green. The final broad/failure task is
   not delivered by PR-04A.
