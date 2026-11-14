# Unified Batch Tuple Matching — implementation and evidence report

## Provenance and scope

This documentation-only task inspected the implemented source/tests and records
the **verified results supplied by the implementation handoff** below. It did
not rerun the suites, reproduce the native crash, or certify unrelated regressions.
Parent final validation is recorded below. Decision:
[ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md); contract:
[merged spec](../../specs/unified-batch-tuple-matching/spec.md).

Implemented areas inspected: [batch helpers](../../../src/lib/joinLensBatch.ts),
[Find Matches UI](../../../src/components/JoinLensAuto.tsx),
[batch Mapping planner](../../../src/app/keyMap/tupleMapping.ts:13),
[App handler](../../../src/App.tsx:3280), and
[atomic reducer](../../../src/App.tsx:380). Rust matching, Suggest Right and
MatchingWorkspace implementations are unchanged by the batch feature. Existing
implementation/test working-tree changes were not edited by this documentation
task. No historical change reports were rewritten.

## Supplied verified results

| Evidence | Result | What it establishes / does not establish |
|----------|--------|------------------------------------------|
| Frontend unit suite | 47 files passed | Includes batch helper/planner coverage; not 47 individual assertions |
| Auto/Find Matches browser component suite | 16 passed | Mocked host/LLM UI, explicit review and session guards; not native execution |
| Existing Suggest Right browser suite | 13 passed | Adjacent single-source component coverage, not all product regressions |
| New batch Electron suite | 5 passed, arities 1–5 | Real CSV, Rust fuzzy, local HTTP mock LLM, one batch commit, execute/Save/fresh reopen/execute |
| Existing Suggest Right Electron suite | 5 passed, arities 1–5 | Single-source tuple execution/persistence regression |
| Rust host tuple lifecycle | 6 passed | Five existing arity cases plus one batch test looping arities 1–5 |
| Rust host tuple suggest | 1 passed | Tuple request and legacy command compatibility |
| Native engine tuple tests, serial | 6 passed | Tuple scorer/identity/bounds; parallel safety is not established |
| Native engine tuple tests, parallel attempt | **Crashed with SIGSEGV** | Known failed attempt; serial pass does not erase the failure |

No broader engine/pipeline/host library count, dbt run,
or comprehensive unrelated Electron regression is claimed for this batch work.
Older reports contain their own historical results, not additional runs here.

### Parent final validation

- Reran all 47 unit files, TypeScript no-emit checking and the production build:
  passed. Build retains the existing large-chunk warning.
- Reran Find Matches browser tests (16), Suggest Right browser tests (13), and
  the release-host-rebuilt batch Electron journey (5): all passed.
- After the readiness gate was added, reran the 47 unit files, TypeScript check,
  both Host integration suites (6 + 1), all six engine tuple tests serially, and
  the combined rebuilt Electron suites (5 batch + 5 Suggest Right): all passed.
- Extended pure planner/project tests through six keys and added exact offending
  source tuples to batch conflict errors. The header now reports suggestions and
  records without candidates alongside decision counts and JOIN field alignment.
- Reused existing KeyMap entry validation strictly as a readiness check, discarding
  its cleaned rows. Distinct exact keys that collide under the legacy trim-based
  readiness rules are blocked before publication, never merged or normalized.

## Review follow-up: batch format, explicit bulk acceptance and write acknowledgement

The three review findings have been addressed:

1. [Batch prompting](../../../src/lib/joinLensBatch.ts:138) no longer concatenates
   single-record Suggest Right prompts. It emits one ordered Join alignment,
   bounded source groups/allowlists and one response schema. The
   [batch parser](../../../src/lib/joinLensBatch.ts:220) parses once and validates
   all groups; multiple structured payloads and oversized responses are rejected
   wholesale with feedback instead of importing only an initial block. Tuple
   identity/type/arity, source-specific target allowlists and rationale checks
   remain. Suggest Right's own prompt/parser remain unchanged.
2. [Bulk eligibility](../../../src/lib/joinLensBatch.ts:76) uses Rust's existing
   0.88 cutoff and 0.03 ambiguity gap, with every scored competitor checked,
   including below-cutoff/hidden ones. Untouched pending/unselected records only;
   complete right coverage, safe full tuples and fuzzy winner provenance are
   required. Unknown scores, ambiguous/tied competitors, competing LLM proposals
   and user-touched/manual decisions are excluded. The counted action and bulk
   undo change draft decisions only, never project state. Write remains separate.
3. A [local typed receipt](../../../src/lib/joinLensBatchCommit.ts) identifies the
   exact acknowledged resulting context, project session, actual shifted Join
   index and applied count. The wrapper shows a scoped success summary across its
   own committed-context transition, clears old decisions and waits for explicit
   Refresh remaining review. It does not preserve stale actionable rows or revive
   summaries after intervening edits/project switches/ABA. The containing Lens
   survives its own preview reset and Apply insertion. Atomic publication is unchanged.

Follow-up verification: 47 unit files passed; TypeScript checking and production
build passed; Find Matches browser coverage increased to 25 passing cases;
Suggest Right browser coverage remained 13 passing cases. Final parent execution
rebuilt the release Host/UI and passed both Electron suites together: 5 batch
cases and 5 Suggest Right cases. Batch cases now verify real-score bulk acceptance
and undo, a two-source loopback LLM response, persistent success summary, no automatic
retrieval and explicit refresh of remaining records before execution/Save/cold reopen.
Browser tests rerender the parent with changed workspace/Join index before resolving
the commit promise and cover failure, edits, project ABA and oversized/multiple payloads.

Rust scoring was not changed and native engine suites were not rerun for this
follow-up. The previously recorded parallel native SIGSEGV remains unresolved;
paid-model quality, external in-place data freshness and broader connector coverage
are still not certified. Existing large-chunk/native build warnings remain.

## Original Electron source evidence

[join-batch-save suite](../../../e2e/electron/join-batch-save.spec.ts:34) creates
temporary real left/right CSVs, with differing left/right field names and reverse
physical target-column order. Each arity uses five distinct unmatched sources
across six rows, including repeated source occurrences and context guards.

- Two selected targets come from **real Rust fuzzy alternatives** above cutoff;
  all aligned output fields differ. Manual search is deliberately not used to
  manufacture the fuzzy pass.
- A third source has no above-cutoff candidate. An actual loopback HTTP server
  acts as the configured LLM provider, returning one allowed full tuple plus an
  invented tuple. The allowed result joins the same queue; invention is rejected.
  This is not a paid or remote model-quality test.
- The user explicitly selects/accepts three source decisions. Before the one
  **Write Mapping (3)** action, project workspace and real execution remain at
  baseline. The suite samples project state during the operation and checks
  old-or-complete map/entry/Apply states, not a row-by-row published map. This is
  observational E2E evidence, not an exhaustive scheduler/interleaving proof.
- It asserts three complete Mapping entries and an unchanged Join definition;
  real Join execution checks the effect of the aligned output bindings. It
  performs real project Save, terminates Electron, launches a **fresh
  process**, opens the saved project and executes again. Persisted mappings and
  outputs agree. Context guard sources stay unmapped and the repeated source
  maps consistently. Screenshots are emitted per arity after commit/reopen.

The [host lifecycle test](../../../crates/dwh-host/tests/join_tuple_lifecycle.rs:327)
also loops batch arities 1–5, retrieves without workspace mutation, then exercises
complete multi-entry Mapping/Apply execution and cold Save/reopen. It constructs
the committed workspace directly; it does not prove the renderer reducer path.

## Evidence commands / reproducible entry points

Run from the repository root. These commands are derived from the checked-in
test sources/configs and harness; they are rerun instructions, **not a claim of
the exact historical shell invocation or new execution by this docs task**.

| Scope | Command |
|-------|---------|
| Units | `npm run test:unit` |
| Find Matches browser | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test -c src/components/JoinLensAuto.playwright.config.ts` |
| Suggest Right browser | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test -c src/components/FindRightDialog.playwright.config.ts` |
| New batch Electron | `xvfb-run -a npm run test:e2e:electron -- join-batch-save.spec.ts` |
| Existing Suggest Right Electron | `xvfb-run -a npm run test:e2e:electron -- join-tuple-save.spec.ts` |
| Host lifecycle | `cargo test -p dwh-host --test join_tuple_lifecycle` |
| Host tuple suggest | `cargo test -p dwh-host --test join_tuple_suggest` |
| Engine tuples, serial | `cargo test -p dwh-engine --lib join_fuzzy::tuple_tests -- --test-threads=1` |
| Engine tuples, parallel/default threads (known crash attempt) | `cargo test -p dwh-engine --lib join_fuzzy::tuple_tests` |

Sources: [unit harness](../../../scripts/run-unit-tests.mjs),
[Auto browser config](../../../src/components/JoinLensAuto.playwright.config.ts),
[Suggest Right browser config](../../../src/components/FindRightDialog.playwright.config.ts),
[Electron runner](../../../scripts/run-electron-e2e.mjs),
[Electron config](../../../playwright.config.ts),
[isolated launch helper](../../../e2e/electron/helpers/launch.mjs),
[host suggest test](../../../crates/dwh-host/tests/join_tuple_suggest.rs), and
[engine tuple tests](../../../crates/dwh-engine/src/join_fuzzy_tuple_tests.rs).
The browser override assumes system Chromium at that path; omit/adapt it where
Playwright's browser is installed. Xvfb is for headless Linux; an existing display
can run the same npm harness without it.

The Electron runner normally rebuilds the release host and E2E-enabled UI before
running only the selected suite; skipping builds risks stale evidence. It reports
which host binary is selected, including portable-binary precedence. Launch uses
isolated app state and existing E2E hooks to bypass native Open/Save pickers;
search, execution and persistence are real, not mocked. A separate production
build is not implied by an E2E-enabled UI build.
The engine filter uses the actual
[tuple_tests module declaration](../../../crates/dwh-engine/src/join_fuzzy.rs:1380),
not its differently named source file, to avoid a misleading zero-test run.

## Exact gaps and limits

- **CSV only, not Parquet.** No live PostgreSQL or other external database/content
  mutation scenario is established by these batch lifecycle tests. No dbt/export
  execution or every storage/temporal variant was independently rerun.
- **No paid LLM.** Browser mocks and Electron loopback provider test request shape,
  candidate validation and UI integration, not remote latency, billing, model
  accuracy, or all providers' network/permission behavior.
- **MatchingWorkspace unmodified and not independently exercised.** Its separate
  plan/cascade/host validation/Save contract is not certified by batch tests.
  Suggest Right has the specifically listed adjacent browser/Electron evidence,
  not a claim that every manual Mapping path was retested.
- **Parallel native crash remains open.** The default-thread engine tuple attempt
  terminated with SIGSEGV. Six serial tests passed. No root cause or fix is
  established here; do not describe the native parallel suite as green.
- **Definition freshness only.** Full workspace/connections/sources/project-ref
  fingerprint is local and can include secrets; never transmit or log it.
  External files/tables changed in place are not detected by that fingerprint.
  This is not database snapshot isolation or evidence-content versioning.
- **Bounded review.** 200 distinct tuples per side; fuzzy cutoff 0.88; initial
  fuzzy UI 8 per source; manual 20/page; LLM 4 groups × 12 targets within 10,000
  characters; chat 6 × 4,000 characters. Prompt omissions/truncation remain
  visible; manual search/LLM are not dataset-wide. No global session call/currency
  budget or durable batch draft restore is added.
- **Representability.** NULL/empty/whitespace-only tuple parts are blocked via
  [tupleMappingBlock()](../../../src/lib/joinLensTuple.ts:18); significant
  whitespace and literal ∅ retain exact identity. This does not prohibit existing
  whitespace-only stored values under ADR-0037 generally.
  Distinct From tuples that collide under existing KeyMap trim-based uniqueness
  are also blocked as unrepresentable; cleaned validator output is never stored.
- **Real-data/UI arity evidence is 1–5; pure planner tests extend to six.** The
  implementation is generic for positive arity, but larger execution arities,
  arbitrary data sizes and all race interleavings are not
  exhaustively tested. The five successful Electron runs do not demonstrate every
  conflict/stale branch; helper/browser tests provide narrower supporting evidence.

## Documentation delivery

New ADR, proposal/deltas/design/tasks/report and merged batch contract; updated
merged composite Auto/in-place confirmation contracts; narrow ADR-0024/0037/0038/
0042/0044/0049 amendments; Matching/Suggest Right merged-spec boundary notes;
OpenSpec index and agent entry points. Changes are limited to documentation.
Parent final review/validation is recorded above. The native crash remains an
explicit separate follow-up, not a passing parallel test result.

Documentation checks performed here: working-tree whitespace check passed;
relative links in the new documents resolved; all three complete change-spec
texts matched their merged counterparts after normalizing link depth and delta
headings. These checks do not execute product tests.

### Files changed by this documentation task (21)

- [Agent entry points](../../../AGENTS.md).
- [ADR-0024 amendment](../../../docs/adr/0024-keymap-composite.md).
- [ADR-0037 amendment](../../../docs/adr/0037-keymap-multi-output.md).
- [ADR-0038 amendment](../../../docs/adr/0038-keymap-apply-operation.md).
- [ADR-0042 amendment](../../../docs/adr/0042-join-lens-in-place-confirm.md).
- [ADR-0044 amendment](../../../docs/adr/0044-matching-workspace.md).
- [ADR-0049 amendment](../../../docs/adr/0049-unified-suggest-right.md).
- [New ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md).
- [OpenSpec index](../../README.md).
- [Proposal](proposal.md).
- [Batch delta spec](specs/unified-batch-tuple-matching/spec.md).
- [Composite Auto delta spec](specs/keymap-composite-auto/spec.md).
- [In-place confirmation delta spec](specs/join-lens-in-place-confirm/spec.md).
- [Design](design.md).
- [Tasks](tasks.md).
- [This report](report.md).
- [Merged batch contract](../../specs/unified-batch-tuple-matching/spec.md).
- [Merged composite Auto contract](../../specs/keymap-composite-auto/spec.md).
- [Merged in-place confirmation contract](../../specs/join-lens-in-place-confirm/spec.md).
- [Merged Matching workspace boundary amendment](../../specs/matching-workspace/spec.md).
- [Merged Suggest Right boundary amendment](../../specs/unified-suggest-right/spec.md).
