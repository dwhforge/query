# PR-00A baseline — 2026-11-13

Unmodified source HEAD: `5a408b90997558ffcf05f2cbc60389aafe45f2e4`
(`feature/matching`). Working tree was clean before investigation.

| Check | Result |
|---|---|
| npm ci | Passed; 177 packages installed; audit reports 4 high-severity vulnerabilities (not fixed in this scope) |
| npm run build | Passed; existing large-chunk warning |
| npm run test:unit | Passed |
| npm run test:e2e:electron | Failed: 33 passed, 2 failed, 2 skipped |

Electron failures before any source changes:

- `help-lab-journey.spec.ts:128`: comparison links show original/prepared/monthly previews.
- `mapping-create.spec.ts:291`: source key `to`, review `to_2`, create/save context.

Raw baseline logs are retained locally under `/tmp/dwh-query-pr00a-baseline/`.
The Electron entry point rebuilt the release host and E2E UI; worker messages
about skipping the host build refer to that already-built host, not an omitted
entry-point build. No manual smoke or Rust test suite is claimed passed here.

## Assignment review against current HEAD

The proposed order is appropriate: repair trust boundaries before refactoring.
Deliver PR-00A independently, then PR-00B, not a single architecture-wide PR.

1. **PR-00A confirmed.** Planning marks proposals saved before persistence;
   the callback can return without a target and ignores the save result.
   The current merge helper also preserves conflicting filled cells, so it is
   not a replacement-write implementation for explicitly approved changes.
   Re-plan against current map data; acknowledge only the actual outcome.
2. **Define persistence accurately.** Mapping Save writes the local project AST
   before external sync. Project-file Save/Save As is a separate operation.
   External failure must retain Matching decisions without claiming rollback
   of the local AST or a committed warehouse write. A retry after failed seed
   sync must not mistake the local AST for successful external persistence.
3. **Source maps need real baselines.** Their project entries are intentionally
   empty. Use existing exact-key reads and dirty-delta concurrency, never infer
   absence from an empty/paged editor cache. Ref/query maps must not gain a new
   write path. Unrelated dirty editor drafts must not be implicitly saved.
4. **PR-00B confirmed.** Live and fixture execution must be separated; demo
   labeling alone must not authorize fixture writes into a user's live map.
5. **PR-01–05 are extraction goals, not missing-feature mandates.** Preserve
   the already delivered ADR-0045 safe replacement and ADR-0046 assistance,
   the pure lifecycle core, and existing live refs/request generations. Test
   late decisions/map edits during Matching Save as well as late project edits.
6. **PR-03 confirmed navigation defect.** Matching's Lens action currently
   changes the center tab/layout without selecting its original query/JOIN.
7. **Cancellation is not transaction rollback.** Test cancelled/rejected replies
   and stale-session acknowledgements; do not invent a cancellable mutation
   protocol (ADR-0031). Keep the draft when success cannot be established.
8. **PR-06 remains conditional.** No Compare implementation, generic runtime,
   tool registry, new store, or persisted context is justified in this slice.
9. **Acceptance evidence must stay granular.** Existing flagship Electron
   tests already cover substantial guidance and navigation; extend them rather
   than duplicate them. The full user-data/restart/export journey, live PostgreSQL,
   manual/visual smoke, and full-input equivalence are not established by a
   green sample preview or the unit suite.
