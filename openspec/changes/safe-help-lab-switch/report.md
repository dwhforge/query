# PR-01 delivery report — safe Help Lab switch

## Scope and baseline

- Delivery: one local PR-01 implementation slice; no hosted PR created.
- Executor branch: feature/matching.
- Brief baseline: fd6f1691847a23d793ca8a5a1aa4c06652886eae.
- Executor baseline: bd61e2b4a90d2efa482fd4462a896df535a4af89.
- Those baselines differ only in two Matching files; they were not changed here.
- Platform exercised: Linux, Node 20.20.2, Electron under Xvfb, actual release Rust host.

## User-visible behavior

Opening a lab now replaces the project as opening another project does. Unsaved
project changes trigger **Save / Discard / Cancel**. Save must finish successfully
before switching; picker cancellation or a failed write leaves the current work
open. Discard explicitly opens without saving. Cancel preserves project and tabs.
Unchanged saved projects do not receive a redundant warning.

Each lab starts from the standard project constructor with a new identity and no
previous save target, linked export tree, references, bindings, outputs or checks.
Global connections/settings remain available. The reconciliation flagship uses
DuckDB even with PostgreSQL app defaults (constructor unit coverage). Its existing
dirty join focus and partial map remain intact.

Separate Mapping/Matching drafts are disclosed in the same dialog. Save does
**not** silently write those drafts to a warehouse or accept proposals. Instead,
the switch stops and explains that the drafts need saving in their own editors.
Explicit Discard is still available. Project/map writes already in flight block
replacement. Changed project/draft tokens prevent a late load from committing.

## Reproduction before

An isolated saved fixture was opened through real host IPC, then its first query
was renamed without saving. Help Lab → flagship Open replaced the workspace
without a warning. The runtime project became the demo while retaining the
temporary working project's save path. The regression failed because the
protection dialog did not exist. No real user project or destructive Save was
used to prove this risk.

## Changed files

- [App integration](../../../src/App.tsx): shared guard, save outcomes/baseline,
  clean project application, editor cleanup, write guards and stale export reply protection.
- [Lifecycle helpers](../../../src/app/projectLifecycle.ts) and
  [unit tests](../../../src/app/projectLifecycle.test.ts): independent lab
  construction and staged permission/save/load/commit checks.
- [Project switch dialog](../../../src/components/ProjectSwitchDialog.tsx):
  English UI, native modal focus containment, Cancel default, Escape cancellation.
- [Electron regressions](../../../e2e/electron/help-lab-switch.spec.ts).
- [ADR-0045](../../../docs/adr/0045-safe-help-lab-switch.md), explicit
  [ADR-0013 supersession note](../../../docs/adr/0013-project-persistence.md:23),
  OpenSpec packet, merged [Help Lab contract](../../specs/help-lab/spec.md), and media.
- No Rust, fixture/catalog, Mapping IR, cloud, LLM or general Guidance changes.

## Automated acceptance table

All 13 rows below passed in the final targeted Electron run. Native path picker
results are stubbed in Electron main; host load/save and disk files are real.

| Step | Expected | Actual / result |
|---|---|---|
| Edited saved project → lab → Cancel | Graph, tabs, identity and save path stay intact | PASS; project equality and old-file bytes checked |
| Discard → lab → Save → reopen | New identity, clean linkage, new picker target; old file unchanged | PASS; saved lab identity and focus round-trip |
| Save before opening lab | Working edits saved first, then clean lab | PASS; old file contains edited query and original identity |
| Cancel first-save picker | Keep unsaved project open; allow retry | PASS; project equality, unchanged old file and Escape cleanup |
| First Save to chosen file | Persist working project before opening lab | PASS; real selected file inspected |
| Failed Save to directory | Keep current work; allow retry | PASS; actual host write error and unchanged project |
| Unchanged saved project → lab | No unnecessary warning | PASS |
| Open → Cancel / failed load | Same protection as lab opening | PASS; missing-file error leaves project intact |
| Edit Mapping cell → Cancel / Save | Keep cell draft; project Save is not draft Save | PASS; actual grid edit survives, explicit explanation shown |
| Open Recent → Cancel | Same protection | PASS; project equality checked |
| Open unavailable recent | Preserve failed-recent pruning | PASS; unavailable entry removed |
| Save succeeds, next load fails | Keep saved current project open | PASS; saved bytes, identity/path and clean-baseline retry checked |
| Save as → lab | Old file unchanged; independent saved fork baseline | PASS; new UID and file contents checked, no false dirty warning |

Unit coverage additionally checks late project/draft changes, load failure,
cancelled/failed Save outcomes, busy-write refusal, clean-project bypass, global
connection preservation and advanced-demo routing presets. It does not claim a
held real host write was exercised in Electron.

## Exact test results

| Command / suite | Actual result |
|---|---|
| [UI build](../../../package.json:10) | Final exit 0; existing large-chunk warning remains |
| [Unit runner](../../../scripts/run-unit-tests.mjs) | Final exit 0; all 29 test files pass |
| [Targeted Electron runner](../../../scripts/run-electron-e2e.mjs) with the new suite | Final exit 0; 13 passed in 55.5s including worker overhead |
| Full Electron suite, earlier 9-test PR-01 revision | 14 passed, 1 failed, 2 skipped; not a green full-suite claim |
| Existing mapping-create collision-name scenario on unmodified executor HEAD | Same failure waiting for the expected collision-safe output name; baseline reproduction confirmed |
| [Pipeline package tests](../../../crates/dwh-pipeline/Cargo.toml) | Exit 101; 168 passed, 2 failed |
| [Engine package tests](../../../crates/dwh-engine/Cargo.toml) | Exit 101; 115 passed, 1 failed, 1 ignored |
| [Host package tests](../../../crates/dwh-host/Cargo.toml) | Exit 101; 31 passed, 2 failed |

The pipeline failures concern absolute versus relative reference-copy paths.
The engine failure concerns an unknown prior schema for an ApplyKeyMap output.
The host failures concern the format-version assertion and a Mapping quality
projection with unknown prior schema. Rust source/manifests/lockfile have no diff
from the executor baseline. These are recorded failures, not silently repaired
in the UX slice. The Rust runners stopped at failing library suites, so later
integration/doc suites are not claimed executed. PostgreSQL Electron scenarios
were skipped because their external environment was not configured.

Local command logs are under the ignored build output directory: final UI/unit/
Electron logs and individual Rust package logs carry the PR-01 prefix. Playwright
also produced its normal local report/traces. These generated logs are not
committed or treated as durable screenshot assets.

## Visual evidence

- [Before: demo retained the previous project path](../../../docs/stabilization/help-lab-switch-before.png).
- [After: replacement confirmation with working project still intact](../../../docs/stabilization/help-lab-switch-after-prompt.png).
- [After: independent unsaved lab with dirty join focus](../../../docs/stabilization/help-lab-switch-after-lab.png).

Screenshots were captured from the running Electron app and inspected. The lab
image proves context and unsaved save identity, not tutorial completion, a full
data reconciliation, or a human comprehension study. No video was recorded.

## Known limitations / follow-up

- Mapping/Matching drafts require their existing editor Save before using the
  dialog's Save path. This slice intentionally does not implement Save-all or
  automatic Matching acceptance/warehouse writes.
- Matching decision-session warnings and in-flight warehouse writes have source/
  shared-guard coverage, but no real Matching-decision or live warehouse E2E in
  this delivery. Late-load race behavior is unit-tested, not a held-host E2E.
- Opening another project clears old editor tabs rather than leaving stale
  editors attached to a different document. Startup restore and test-only hooks
  remain bootstrap/setup paths, not user-initiated replacement UI.
- This does not add application-wide quit protection, editor text-draft tracking,
  or a persistent Matching session store. Applied project edits and existing
  Mapping/Matching dirty signals are the protection boundary.
- No clean-machine installation, Windows/macOS visual pass, human full-journey
  acceptance, mapping correction demo, or one-minute comprehension test claimed.
- PR-02, PR-02H, PR-03, broader PR-04 and PR-05 remain separate future slices.
