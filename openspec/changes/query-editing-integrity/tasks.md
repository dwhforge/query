# Tasks

## Follow-up review at HEAD 6f15be6
- [x] Confirm silent soft scrub and audit existing dependency/round-trip tests.
- [x] Add structured deletion preparation and UI-only confirmation with graph revalidation.
- [x] Cover cancellation, acceptance, stale confirmation and Mapping edge decisions.
- [x] Run units, TypeScript and rebuilt Electron regression tests.
- [x] Merge updated contracts and record results and limitations.

### Follow-up evidence and limits
- Confirmed at clean HEAD `6f15be6`: Query deletion silently scrubbed Join/Append
  references. Pure preparation now exposes every affected operation; the UI
  requires consent and commit rechecks hard blocks plus a target-bound graph token.
- Existing direct FromQuery/SqlModel/CustomSql, query-backed Mapping and Mapping
  Check deletion guards were already covered in `integrity.test.ts`; retained.
  Creation/derivation KeyMap loss was not reproducible at this HEAD.
- Mapping protection remains unchanged: direct/transitive protected input edits
  reject; unrelated seed/query maps and checks do not blanket-block edge removal;
  absent-edge no-ops remain allowed. Verified in units and a loaded-project
  Electron Query-backed Mapping case. No safe relaxation was established.
- `npm run test:unit`: all 43 files passed. `npx tsc --noEmit`: passed.
- Host release build and E2E UI build passed through the Electron harness.
  Final Playwright run: **55 passed**, covering query-editing, query-inspector,
  query-navigation, execution-states, workspace-tabs, mapping-create and
  help-lab-journey. Later runs reused the host built at task start; UI rebuilt
  after production changes. Rust/IPC/project formats were not changed.
- Early Electron failures exposed test synchronization and assertion issues:
  wait for drag connection state and async JOIN commit; compare graph after
  documented relative-path/default-execution normalization; seed explicit map
  defaults. Final run passed without retries. Obsolete experimental gesture
  repeats are not counted as passing coverage.
- Save/reopen compares the complete resulting Query graph and full KeyMaps;
  actual SQL-model/file/Source creation and derivation are exercised.
- Remaining limits: protected Mapping inputs intentionally use conservative
  closure guards; any graph-definition change invalidates deletion confirmation
  (layout alone does not). Consent does not prove downstream SQL/column validity.
  No live Postgres creation/execution or arbitrary production project audit was
  performed; Electron uses the repository's isolated CSV-backed fixture.

## Original integrity work

- [x] Inspect combined review, current HEAD, ADRs/contracts and baseline tests.
- [x] Review proposal/specs/design and record ADR-0048's bounded policy.
- [x] Fix all five creation paths; extract derive and edge operations.
- [x] Protect Query deletion and add pure operation/service regressions.
- [x] Verify sequential UI edits, KeyMap invariants, host save/reopen and Help Lab.
- [x] Run units, TypeScript, build and rebuilt Electron; record skipped coverage.
- [x] Merge contracts and report each finding, limitations and actual evidence.

## Verification evidence (feature/redesign working tree)
- `npm test:unit` → 43 files green, incl. `Query editing integrity`, `operation` and `service` suites.
- `npx tsc --noEmit` → clean (covers `src/` and `e2e/electron/*`).
- New E2E `sequential create/derive/edit/remove round-trips through Save + reopen without losing KeyMaps` → passes; Help Lab journey + mapping-create save/reopen → pass.
- Skipped from this run: `cargo host:build` (binary present, DWH_E2E_SKIP_HOST_BUILD=1) and the full `run-electron-e2e.mjs` orchestration harness (host rebuild). The added spec runs under the existing Playwright Electron driver.
