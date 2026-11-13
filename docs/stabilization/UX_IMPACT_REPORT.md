# Immediate UX impact — delivery and evidence

## Baseline and delivery slices

Brief baseline: fd6f1691847a23d793ca8a5a1aa4c06652886eae (main).
Executor baseline: bd61e2b4a90d2efa482fd4462a896df535a4af89, feature/matching.
The baseline difference was confined to two existing Matching files; this batch
does not modify them. Delivery is a series of local reviewable commits, not a
claim that hosted PRs, releases or downloads were published.

| Slice | Change | Evidence / contract |
|---|---|---|
| PR-01 · 7de08b5 | Save-before-replacement and independent lab identity | [Report](../../openspec/changes/safe-help-lab-switch/report.md), ADR-0045 |
| PR-02 · 7f86c10 | English dismissible task and deterministic start | [Report](../../openspec/changes/recon-lab-task/report.md), ADR-0046 |
| PR-02H · 48065d3 | Opt-in inline Join → No match hints | [Report](../../openspec/changes/recon-lab-hints/report.md) |
| PR-03 · a5aeebb | Original / prepared example / monthly comparison links | [Report](../../openspec/changes/recon-lab-comparison/report.md) |
| PR-04 · 84330e7 | Reproduced preview freshness, cancel/error/empty and sample/full fixes | [Audit](../../openspec/changes/execution-confidence/report.md) |
| Hint completion follow-up · a1249ec | Stop completed runs intercepting ordinary Escape | Electron reproducer added to [journey suite](../../e2e/electron/help-lab-journey.spec.ts) |
| PR-05 | Real flagship presentation, offline-first instructions and release boundary | [README](../../README.md), [guide](../GETTING_STARTED.md), [demos](../DEMOS.md), [development notes](../RELEASE_NOTES.md) |

Runtime behavior deltas are merged into [Help Lab SoT](../../openspec/specs/help-lab/spec.md)
and [execution lifecycle SoT](../../openspec/specs/execution-lifecycle/spec.md).
PR-05 changes no runtime behavior, so it adds no new product contract or ADR.

## Reproducible acceptance ledger

| Step | Expected | Actual / result | Media / test |
|---|---|---|---|
| Edit working project → open lab → Cancel | Preserve edits, tabs and save target | PASS: project equality and old file bytes checked | [Switch suite](../../e2e/electron/help-lab-switch.spec.ts), [prompt](help-lab-switch-after-prompt.png) |
| Save / Discard / failed Save / cancelled picker | Replace only after successful Save or explicit Discard | PASS on actual temporary files and host I/O | Switch suite, 13 scenarios |
| Open flagship | Original dirty Join, one task, independent unsaved lab | PASS | [Task](recon-task-card.png) |
| Show me → Join / No match | One optional pointer; semantic progression and completion | PASS including alternative path, Got it/Escape and cleanup | [Hint](recon-no-match-hint.png), [narrow fallback](recon-hint-narrow.png) |
| Original → mapped example → monthly | Correct existing query/step, honest partial-example labels | PASS on real previews; no invented KPI | [Monthly](recon-monthly-comparison.png) |
| Add COM-AMM → AMM-A in existing map → Save → Recompute | Show actual changed example rows | PASS: COM-AMM rows replaced by AMM-A rows; monthly output inspectable | [Journey suite](../../e2e/electron/help-lab-journey.spec.ts) |
| Save as → reopen | Separate file/identity, reproducible saved content | PASS; tutorial session deliberately does not persist | Switch suite |
| Switch query while preview pending | Never show prior-query rows as current | Reproduced failing before, PASS after | [Before](execution-pending-before.png), [after](execution-pending-after.png) |
| Cancel, error, empty, sample/full, late reply | Explicit states; no stale completion | Reproduced before, regression PASS after, including retries | [Execution suite](../../e2e/electron/execution-states.spec.ts), [error after](execution-error-after.png) |
| Flagship without PostgreSQL/LLM/dbt build | Complete inspect/edit/recompute path locally | PASS in isolated Electron sessions; no such service needed | [Actual No match](flagship-join-lens.png) |

This is an automated/interactive-agent evidence table, not a claimed human
comprehension session. Screen recordings were not produced; screenshots are
from running Electron, not generated mockups.

## Validation boundary

- Clean npm dependency installation succeeded on this Linux development machine,
  followed by UI build and all **31 unit-test files** passing.
- Initial documentation tests checked 25 documents and 88 local links/media references;
  release, main and feature/matching GitHub pages each returned HTTP 200.
  The final test includes this consolidated report: **26 documents, 114 local
  links/media references**, plus the same three HTTP 200 checks.
- Git confirmed remote default main at fd6f169 and the published feature branch
  at the PR-01 commit when checked. New local commits are not claimed downloadable
  until the maintainer publishes them. CI defines Linux/Windows package targets.
- Full Electron suite and three Rust package suites were run; their non-green
  results and final counts are recorded in the final validation section below.
- npm installation reported **4 high-severity advisories**. No dependency
  auto-upgrade or audit-fix was applied as part of UX work.

## Known limitations

- Separate Mapping/Matching drafts use their own existing Save; this is not
  Save-all, silent warehouse write-back or automatic proposal acceptance.
- No idle reminder/timer, general Guidance engine, new workspace store, event bus,
  fixture, reconciliation engine, backend cosmetics or mandatory cloud call.
- A clean sample or the prepared example is not full-input reconciliation proof.
- Real PostgreSQL, cross-platform clean-machine installation, held Model IPC,
  full durable Matching-session lifecycle and human one-minute comprehension
  testing are not claimed. PostgreSQL E2E is environment-gated.
- Existing broader mapping-create and Rust failures remain separate stabilization
  work; they were not hidden or expanded into an unrelated engine refactor.

## Final validation

| Command / suite | Actual final result |
|---|---|
| Clean npm dependency installation | Exit 0; 177 packages installed; 4 high advisories reported |
| UI build | Exit 0, including rebuild in final Electron runner; large-chunk warning remains |
| Unit runner | 31/31 files pass |
| Full Electron runner after final Escape fix | 34 passed, 1 failed, 2 skipped, 2.6 minutes; all 29 new safety/journey/execution cases pass |
| Pipeline Rust package | Exit 101; 168 passed, 2 failed |
| Engine Rust package | Exit 101; 115 passed, 1 failed, 1 ignored |
| Host Rust package | Exit 101; 31 passed, 2 failed |

The sole full-Electron failure is the existing
[mapping-create collision-name scenario](../../e2e/electron/mapping-create.spec.ts:291),
waiting for its expected output name. PR-01 independently reproduced it on the
unmodified executor HEAD in an isolated worktree. Both PostgreSQL tests were
skipped by their environment gate, not passed.

The two pipeline failures assert reference path absolutization; the engine
failure concerns unknown prior ApplyKeyMap schema; host failures concern the
format-version assertion and Mapping-quality projection schema. They repeated
the PR-01 results with no Rust source/manifest/lockfile changes. Failing library
suites stop their later integration/doc suites, which are not claimed executed.

An earlier PR-02 combined run encountered one Electron first-window startup
timeout; the exact test passed on an explicit retry. Final full runs did not
require retry. No automatic retry or hidden pass conversion was added.

Raw final logs and Playwright traces remain in ignored build/test output folders;
the linked screenshots and this report are the committed durable evidence. This
delivery must not be read as asserting a green repository-wide test suite.
