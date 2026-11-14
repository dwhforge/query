# Tasks

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
