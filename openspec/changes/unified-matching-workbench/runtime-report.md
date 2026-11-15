# ADR-0052 — runtime implementation and verification

Date: 2026-11-15. Reinspection baseline: **3939be0**, clean worktree on
**feature/redesign**. Phase 1 documentation was already committed and is retained.
The user accepted the architecture and authorized Phases 2–4 with three mandatory
amendments; no further approval gate was introduced.

## Delivered implementation

- The existing [Matching workspace](../../../src/components/MatchingWorkspace.tsx)
  now composes focused [record values](../../../src/components/matching/RecordValues.tsx),
  [relationship browser](../../../src/components/matching/RelationshipBrowser.tsx) and
  [inspector](../../../src/components/matching/RelationshipInspector.tsx). The
  workspace shrank from 2,021 to approximately 1,600 lines rather than absorbing
  another subsystem. No new engine, global store, RPC, durable draft or broad App
  ownership refactor was added.
- Labelled exact LEFT keys and RIGHT outputs replace opaque target identifiers.
  NULL, empty and whitespace values remain distinct. Basic identity is explicitly
  the acquired RIGHT tuple, **not** an invented vendor ID; Advanced identity and
  actual acquired context fields retain their separate roles.
- Previous/next unresolved, per-source temporary picks, explicit pick then confirm,
  opt-in advance, keyboard selection separate from confirmation, preserved filters
  and a visibly pinned inspector replace hidden automatic source substitution.
  Candidates remain visible and bounded; bulk/assistant/technical controls are
  secondary. Confirm still stages only the existing ledger decision.
- RIGHT uses **one** readable, paged related-LEFT list with multi-provenance badges
  and filters. Suggested/draft/Mapping original keys merge losslessly. Executed
  input keys inhabit a distinct namespace in that same list: transformations do
  not magically recover original aliases. Authorities, counts and coverage are
  separate and non-additive. Saved-only/executed-only records are read-only.
- [Sparse selectors](../../../src/app/matching/relationships.ts) reference acquired
  records and stored edges, not a Cartesian product. Review projection preserves
  unchanged collection identity; focus/search/panel changes do not rebuild the
  graph. The 10,000-source/edge unit probe measured **21.2 ms** in the final unit
  run (timing is diagnostic, not a portable performance SLA). Render pages bound
  candidate/target/related lists to 20 rows; source paging remains the existing
  policy. Executed samples are capped at 50. Caches retain at most 8 executed-key
  replies and 16 source-scoped lookup pages. Full UI heap profiling is not claimed.
- The [shared pure resolver](../../../src/app/keyMap/tupleMapping.ts) preserves
  batch attached-map preference, exact generated name/schema and storage policy.
  Direct Suggest Right retains its historical selection behavior. Compatible seed
  definitions are a read-only projection, separate from the frozen write baseline;
  source/query/ref/range baselines are explicitly unavailable, never empty-complete.
- The narrow [App port](../../../src/App.tsx) delegates explicit actual inspection
  to the existing key explanation RPC against the original JOIN, with pre/post
  context checks. Full LEFT/RIGHT/result row counts and timestamped bounded LEFT
  examples are distinct from proposals and from historical previews. Intent epochs,
  context ownership and bounded caches reject stale/ABA replies and do not grant
  write authority. Advanced manual lookup keeps its own source/page replay through
  LEFT/RIGHT navigation; another source's lookup never authorizes a pair.
- The [existing vendor catalog card](../../../fixtures/labs/catalog.json) teaches
  business actions, not algorithms. The real journey preserves the vendor-ID seed,
  creates a separate compatible name/region Mapping via existing preparation,
  refreshes to show the original alias and a new draft against the same RIGHT,
  verifies invoice i5 resolves to V11, saves and cold-reopens equivalent execution.

## Runtime evidence

All commands were run in this checkout on headless Linux with the existing
repository runners. Native tests were serialized; no prior report's pass count
is substituted for current evidence.

| Gate / command | Result |
|---|---|
| `npm run test:unit` | 50 files passed in the final rerun (including stable review projection and sparse reverse tests) |
| `npx tsc --noEmit` | Passed repeatedly during implementation |
| `npx playwright test -c src/components/MatchingWorkspace.playwright.config.ts` | 44 passed (56.3 s final full run), including baseline no-op/conflict/multi-badge tests |
| `cargo test -p dwh-host --test join_tuple_suggest --test join_tuple_lifecycle --test matching_advanced_join -- --test-threads=1` | 19 passed: 2 + 6 + 11 |
| `cargo test -p dwh-engine join_lens::tests -- --test-threads=1` | 7 passed |
| Rebuilt core Electron run: Basic, Advanced, residual, Mapping Save and workbench | 33 passed, 1 vendor-journey test issue; corrected and rerun separately |
| Rebuilt surrounding Electron run: Candidates, Suggest Right, Help Lab journey/switch, workspace tabs and workbench | 42 passed, 1 vendor test setup race; corrected and rerun |
| Final combined rebuilt Electron run | **71 passed (5.5 minutes)**; fresh release Host + E2E UI |

Final combined entrypoint:

```sh
xvfb-run -a node scripts/run-electron-e2e.mjs matching-workbench join-batch-save matching-advanced matching-residual matching-save join-candidates join-tuple-save help-lab-journey help-lab-switch workspace-tabs
```

The runner rebuilt release Host and E2E UI. Selected binary:
**target/release/dwh-host**, not portable-beside-app. Real CSV/DuckDB and delegated
IPC responses drive acquisition, inspection, verification, atomic writes and
cold reopen. Browser/component fixtures supplement, never replace, that evidence.

### New real integration assertions

[Workbench journeys](../../../e2e/electron/matching-workbench.spec.ts) cover the
vendor workflow above, 60 LEFT input rows / 2 RIGHT input rows / 120 result rows
with only 50 sampled LEFT rows, and held real executed replies after focus ABA,
context ABA, project replacement and close. These cannot install evidence, decide
or publish. The [residual journey](../../../e2e/electron/matching-residual.spec.ts)
now takes a zero-soft-score, beyond-shortlist manual lookup through RIGHT focus
before the same explicit confirmation and final Host page replay/cold reopen.
Existing stale-context, failed private Apply, both Save/write orderings, LLM,
Basic arities 1–5, Advanced constraints, Mapping-only Save, Lens and Suggest Right
assertions remain in their original suites with adapted interaction selectors.

### Failures and corrections, not hidden acceptance

- Initial browser runs exposed old tests that closed the now-open candidates or
  expected always-open secondary controls/one-click decisions. Tests now explicitly
  open controls and pick **then** confirm, retaining decision/write assertions.
- Mapping baseline initially could have labelled Basic output identity with the
  plan's vendor-ID field name. The browser now labels the actual Basic RIGHT tuple.
- The vendor test initially sampled the seed before asynchronous lab replacement
  finished. Capture now follows actual Matching acquisition.
- First project Save changes project-relative execution context and correctly
  invalidates old review ownership. The journey refreshes remaining review before
  first Save rather than weakening that guard. Draft-close is explicitly discarded
  through the normal UI before shutting down Electron, avoiding a beforeunload hang.
- Cold reopen initially compared unordered SQL rows positionally. It now checks
  complete row multisets and the specific corrected invoice's vendor ID; row order
  without ORDER BY is not a persistence contract.

## Explicit limits and residual acceptance

- Renderer reverse evidence is only acquired installed edges, current decisions
  and compatible acquired seed definitions. It is not all warehouse relationships.
- Existing Host key explanation supplies query-time counts and at most 50 examples
  per grid. Complete arbitrary-large reverse enumeration, future paginated executed
  reverse, original alias lineage after arbitrary transforms and external snapshot
  isolation are **unsupported**, not blockers or sampled-success substitutes.
- Equal output tuples do not identify an independent Advanced target. Execution
  counts are output-key-group facts; NULL follows SQL equality; outer-JOIN result
  rows alone do not prove a partner. Many aliases to one target is not fan-out.
- No new external Mapping reverse-read/download capability was added. Source/query/
  reference/range projections remain visibly unavailable here; existing unsupported
  writes remain unsupported. Frozen Save baselines and page-only hash semantics are
  unchanged. Remote mutable data is not content-fingerprinted by local definitions.
- Automated record/keyboard/navigation assertions are not independent human
  usability signoff. Full narrow-window/accessibility audit, UI heap/latency profiles
  and exhaustive remote-source lifecycle cross-products remain residual acceptance.
  ADR-0051 residual product/performance risks are not closed by this delivery.

Verified bounded contracts are merged into Matching, JOIN diagnostics and Help Lab capability specs;
the original full risk matrix is retained rather than checked off wholesale.

## Final closure checks

- TypeScript no-emit checks and final `npm run build` passed after the Electron run. The existing >500 kB Vite chunk warning remains; no build failure.
- UX docs: 26 documents / 119 local links and media references passed; remote HTTP checks not requested.
- Changed/new documentation and merged capability check: 16 Markdown documents / 281 local links passed, including source line bounds. `git diff --check` passed.
- The original Phase 1 documentation and predecessor reports remain historical, not rerun evidence.
- No commit was created; the implementation is left in the working tree for review.
