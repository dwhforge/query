# PR-00 — Demo baseline / integration verification

Date: 2026-11-14. Scope: the **updated** roadmap's PR-00, not the earlier
Matching Save PR-00A or demo/live PR-00B.

## Starting point and ownership

- Branch: `feature/redesign`, explicitly approved by the owner as the merged
  planned baseline.
- Accepted starting HEAD: `a098b5fbfaeb0f35de907ae57063d8e7c8e3a20d`.
- `feature/matching` also resolves to that SHA at inspection time.
- Initial index and working tree: clean. Changed files relative to that accepted
  starting point: none before verification.
- Before/after ownership: unchanged. App, ProjectController, typed tabs,
  semantic navigation, preview/Join controllers, Query views and Matching
  persistence keep their existing responsibilities. This report does not
  extract/reimplement any of them or change runtime behavior.
- Read AGENTS/Cursor rules, ADR-0031/0032/0039/0041/0042/0044–0047,
  OpenSpec index and relevant merged execution, lifecycle, navigation, preview,
  diagnostics, Help Lab, Matching and Query workspace contracts; reviewed the
  latest Query workspace proposal/spec/design/tasks and delivery handoff.
  No new product decision or behavior contract: no ADR/OpenSpec delta needed.
  Also checked ADR-0043 and its merged relative-path contract when investigating
  the reference failures.

## Reproducible verification

Linux; Node `v20.20.2`, npm `10.8.2`, Cargo `1.98.0`, rustc `1.98.0`.
Local raw evidence: `/tmp/opencode/pr00-baseline/` (not durable repository
artifacts; rerun the commands below on another machine).

| Command | Result |
|---|---|
| `npm ci` | PASS; 177 packages; 4 high-severity audit findings |
| `npm run build` | PASS; existing >500 kB chunk warning |
| `npm run build` after Electron | PASS; restores ordinary production `dist/`, without E2E-enabled renderer |
| `npm run test:unit` | PASS; all 40 test files |
| `TMPDIR=/tmp/opencode npm run test:e2e:electron` | FAIL (exit 1); 65 passed, 1 failed, 2 skipped; 4.2 minutes; no retries |
| `cargo test --workspace` | FAIL; engine: 115 passed, 1 failed, 1 ignored; aborts before remaining packages |
| `cargo test -p dwh-host -p dwh-pipeline` | FAIL; host: 31 passed, 2 failed; pipeline not reached |
| `cargo test -p dwh-pipeline` | FAIL; 168 passed, 2 failed |
| `npm audit --json` | FAIL (exit 1); findings retained in `audit.json`; no automatic dependency changes |
| Manual interactive smoke | NOT RUN; checklist below is not passing evidence |
| Portable package / tagged release | NOT RUN; no release sign-off |

Build/unit/Rust logs use `build.log`, `unit.log`, `cargo.log`,
`cargo-host-pipeline.log` and `cargo-pipeline.log` in the evidence directory.
The final ordinary build uses `build-final-production.log`.
Electron uses `electron.log`, `test-results/` and `playwright-report/`.
The Electron entry point invokes the release host build and rebuilds the E2E UI.
It selected `target/release/dwh-host`, not a portable binary beside the app.
Worker `DWH_E2E_SKIP_HOST_BUILD=1` messages refer to the entry-point build,
not a stale-host opt-out. E2E UI is not a distributable production build.
The Inspector tests overwrite two tracked PR-05 screenshots as a side effect.
Those newly generated images were preserved in the local evidence directory;
only our generated overwrites were restored to the starting HEAD bytes. The
initial verification changed only this report. Follow-up repairs are recorded
separately below.

## Blocking baseline findings

All observed before source edits. Do not classify these as refactor regressions
or suppress them to obtain a green report.

1. Engine: `export_e2e::tests::reference_preview_matches_dbt_build`
   fails at `crates/dwh-engine/src/export_e2e.rs:465`. ApplyKeyMap cannot prove
   whether output `canonical_id` already exists after a step without inferred
   schema. Reproduced alone using:
   `cargo test -p dwh-engine export_e2e::tests::reference_preview_matches_dbt_build -- --exact --nocapture`
   (`cargo-reference-repro.log`).
2. Host: `demo_mapping_quality::tests::lab_has_real_mapping_and_compilable_projections`
   fails at `crates/dwh-host/src/demo_mapping_quality/mod.rs:145`:
   `prev_columns required to allocate collision-safe internal aliases`.
   Reproduced alone with its full test name and `-- --exact`
   (`cargo-quality-repro.log`).
3. Host: `secrets_io::tests::save_project_round_trip_atomic_isolated_home`
   fails at `crates/dwh-host/src/secrets_io.rs:266`. The preceding assertion
   checks `PROJECT_FORMAT_VERSION`, but the on-disk assertion hardcodes `1`;
   actual saved JSON has `format_version: 5`. Reproduced alone
   (`cargo-save-repro.log`). This is evidence of an obsolete assertion, not
   proof of corrupt persistence. No format downgrade is appropriate.
4. Pipeline: `references::tests::local_copy_absolutizes_and_rewrites_deps`
   and `references::tests::owner_relative_path_and_update_and_missing_unused`
   fail at `crates/dwh-pipeline/src/references.rs:2486` and `:2111`:
   `expected absolute path, got rel.csv` and unresolved `data/products.csv`.
   Their Rust-created fixture Loads use `path_kind: Default::default()`
   (Absolute) with relative-looking strings. ADR-0043 makes the flag authoritative;
   do not restore runtime path guessing just to satisfy these fixtures. Review
   fixture intent before changing production resolution.

Audit findings concern `electron`, `extract-zip`, `playwright` and
`@playwright/test`; aggregate is 4 high, 0 critical. Dependency upgrades and
their compatibility checks remain a separate concern, not an automatic audit fix.

### Electron result

- All execution-state, flagship journey, safe project replacement, Matching
  Save/demo-live, Inspector, Query navigation and workspace-tab cases passed
  in this full run.
- The only failure is the previously documented
  `e2e/electron/mapping-create.spec.ts:291` case 6. Its assertion at line 306
  times out after 30 seconds: the wizard review has no visible `to_2`.
  Trace: `test-results/mapping-create-mapping-cre-a5ae8-create-→-save-keeps-context/trace.zip`.
  This is an assertion failure, not a launch closure. No fix is claimed.
- Both PostgreSQL-import cases skipped because `DWH_PG_DSN` is unset.
- The earlier intermittent process closures did not recur in this run.
  One run without closures is not evidence of a causal repair.

One initial diagnostic used the short engine test name with `--exact`, selected
zero tests and exited 0 (`cargo-reference-diagnostic.log`). It is **not** passing
evidence; the full-name rerun above selected the test and failed.

## Existing integration coverage and remaining gaps

The listed Electron files below all passed this run. Their individual legs do
not establish the missing full-chain or human acceptance.

| Requirement | Existing evidence location | Remaining acceptance |
|---|---|---|
| Flagship Show me → Join Lens / No match, honest Sample | `e2e/electron/help-lab-journey.spec.ts` | Human walkthrough and complete edited-lab restart chain |
| Mapping edit → Save map → Recompute changes rows | Same file, partial-map recompute case | Same edited mapping after Save As and process restart |
| Cancel project switch, failed Save, Save As identity/reopen | `e2e/electron/help-lab-switch.spec.ts` | Native-dialog and full-chain human acceptance |
| Preview cancel/supersede, heavy Sample/Full | `e2e/electron/execution-states.spec.ts` | Real own-data cancellation smoke |
| Busy JOIN/rapid query and step switches, late samples/status/errors | `e2e/electron/query-navigation.spec.ts` | Human interactive smoke |
| Inspector edits, Apply, Data/Model, draft retention | `e2e/electron/query-inspector.spec.ts` | Own SQL/data creation + save/restart/recomputed result |
| Query ↔ Mapping ↔ Matching ↔ Help Lab, dirty tabs | `e2e/electron/workspace-tabs.spec.ts` | Human resizing/collapse smoke |
| Real host Matching Save, retry/refusal, seed project reopen | `e2e/electron/matching-save.spec.ts` | No live acquisition claim: save tests inject synthetic live evidence |
| Visible demo/live distinction and fixture write refusal | Same file; `src/app/matching/executionPolicy.ts`, persistence/unit tests | Live Matching intentionally remains unavailable |

Existing tests cover substantial individual legs, but do not establish a single
end-to-end own-project or edited-flagship **close process → reopen** journey.
No real external tester or warehouse write was exercised in this PR-00.

## Manual acceptance checklist — not yet executed

Use disposable project copies, a production Electron build and a freshly built
host. Record OS/build SHA, exact files and failures. Never use a user's only copy.

### One flagship smoke

- [ ] Help Lab → Shipments ↔ Sales → Open lab → Show me → Join Lens → No match.
      Inspect an unmatched key, not just row counts.
- [ ] Confirm `Sample · LIMIT 50` and “not full-input proof”; the prepared
      mapped example must not be presented as the tester's repair.
- [ ] Open existing SKU Mapping; add `COM-AMM → AMM-A`; Save map. Return to
      mapped example; Recompute; check changed rows and monthly result.
- [ ] File → Save as to a new disposable path. Close the application, relaunch,
      Open the saved path. Check graph, map tuple and recomputed rows again.
      Preview rows are recomputed, not promised as persisted result bodies.

### Independent own-SQL / own-data task

- [ ] Open/create a separate disposable project, without loading a lab.
      Add a SQL model using the existing Query controls; Apply own SQL such as
      `select 'own-smoke' as marker, 42 as amount`. Inspect Data and Model SQL.
- [ ] Also import a small tester-owned CSV with known rows; create/edit a Query
      and verify a known filter/aggregate result. Do not call fixture data “own data”.
- [ ] Save, close the process, relaunch and reopen. Check identical committed
      steps and recomputed values with the same input files.
- [ ] Make an edit; request a project switch; Cancel. Confirm graph, selection
      and independent drafts survive. On a disposable path, trigger a save
      failure and confirm no false Saved acknowledgement.
- [ ] While preview/JOIN is busy, change query/step rapidly and Cancel.
      A late reply must not restore cancelled/old rows or reopen stale panels.
- [ ] Switch Query/Mapping/Matching/Help Lab, resize/collapse panels and return.
      Check drafts. Matching live must say unavailable; explicit Demo fixtures
      must remain labelled and unable to write to a user Mapping.

### Product trial record

| Metric | Result |
|---|---|
| Could finish without author help? | NOT MEASURED |
| Time to first useful diagnostic/diff | NOT MEASURED |
| Would use for the next similar real problem? | NOT MEASURED |

Record help needed, failures and the concrete task completed; a prepared demo or
automated test is not an independent tester success.

## Initial verification gate (before repairs)

**Demo-ready verdict: BLOCKED / not signed off.** Build and unit success do not
override the failing Rust baseline, Mapping-create Electron failure or
unexecuted full-chain manual acceptance.
Do not start updated PR-01 graph extraction until blockers are resolved and
PR-00 is reverified. No live Matching, generic SQL-to-graph, Compare, Data Quality
or lineage capability is promised. No commit, tag, plugin/runtime or second
project store is introduced by this verification.

## Follow-up — repair baseline blockers

Owner explicitly requested fixing blockers before continuing. This remains
PR-00, not graph extraction. Baseline results above are retained as historical
evidence, not overwritten by reruns.

Changes under verification:

- Reference test fixtures now explicitly declare intended relative CSV Loads
  as `FilePathKind::Relative`, including the engine reference/export fixture.
  Runtime resolution still trusts `path_kind` (ADR-0043).
- The saved-document assertion reads JSON and checks `PROJECT_FORMAT_VERSION`
  instead of requiring obsolete version 1. Migration, backup and reload
  assertions remain.
- The Mapping Quality compiler test supplies actual prepared schema evidence,
  just as production does, rather than invoking schema-sensitive Apply through
  a bare compiler. Failed Load/SqlModel probes remain assertion failures.
- Mapping-create Electron coverage checks ADR-0037 canonical `output_columns`
  and `authoring_context.target_columns`. Target `product_id` stays named
  `product_id`; an additional real `to → to` collision must allocate `to_2`.
  Both cases still exercise Fields restore, create, save and reopen. Project
  replacement clears tabs; the persisted Mapping is explicitly reopened.

No runtime behavior or serialized format change is intended; no new ADR or
OpenSpec delta.

| Follow-up check | Result |
|---|---|
| `cargo test --workspace` | PASS; engine 116, host 33, host integration 1, pipeline 170; 320 total passed, 1 benchmark ignored |
| Exact engine reference/export reproduction after fix | PASS; 1 selected test; `cargo-reference-fixed-nocapture.log` |
| `npm run test:unit` | PASS; all 40 files |
| First focused Mapping-create Electron run | FAIL; 5 passed, 2 failed on a newly added legacy-field-omission assertion; not a passing repair |
| Final full rebuilt Electron run | PASS (exit 0); 67 passed, 2 PostgreSQL cases skipped without DSN; 3.7 minutes; no retries |
| Final ordinary production build | PASS after Electron; production `dist/` restored; existing large-chunk warning |
| `git diff --check` | PASS |

Follow-up logs: `cargo-after-fixes.log`, `unit-after-fixes.log`,
`electron-mapping-after-fixes.log`, `electron-full-after-fixes.log`.
The final production build uses `build-after-fixes-production.log`.

The focused run confirmed that current project writers retain compatibility
mirrors (`to_column`, `target_column`) alongside canonical lists. The revised
tests assert the canonical lists **and agreement of any legacy mirrors**; they
do not claim the ADR-0037 writer-omission requirement is implemented. Strictly
removing all legacy mirrors is an existing contract-compliance gap requiring
separate review of serialization boundaries. It is not needed to correct
collision allocation and must not silently change saved IR in this baseline
verification.

### Current outcome / ownership

The five original Rust failures and the Mapping-create Electron failure are
resolved. Both ordinary-target and actual name-collision creation round-trips
pass in the same full Electron run. No failures were excluded from that run;
PostgreSQL still requires a configured external DSN.

Before: tests used outdated format/path/compiler/create assumptions.
After: they exercise the existing current contracts, including canonical output
lists, genuine collision allocation and project-replacement tab reset.
Production owners, IPC, format version, execution cancellation, persistence and
Mapping/Matching write policy are unchanged. Changes are limited to four Rust
test sections, one Electron test file and this report. Generated screenshots
were retained locally and their tracked PR-05 originals restored.

**Automated baseline: GREEN. Demo-ready release sign-off: PENDING manual
acceptance.** The manual smoke, full edited-flagship/own-data process restart,
independent user metrics, portable packaging and PostgreSQL integration remain
unverified; this repair does not claim them complete. The production UI is built,
but no commit, release tag or packaged artifact was created. Perform the manual
checklist above before calling PR-00 accepted and starting PR-01.
