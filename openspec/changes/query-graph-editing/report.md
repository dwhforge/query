# Updated-roadmap PR-01 — Query graph edits

Starting HEAD: `b9e63bd6dace6cccf49839a34e01dce80fd9c487`; clean index/tree.
This is the new graph-edit PR-01, not the previous typed-tab PR-01.
The owner subsequently authorized PR-01 and PR-02 sequentially without another
confirmation. No PR-03/Shell extraction is included.

## Before / after ownership

- Before: App implemented Query deletion, JOIN upsert, step move/replace and
  adjacent remove/append rules; deletion computed from captured render queries;
  JOIN index and step selection/error setters leaked through React updaters.
- After: `src/app/queryEditing/operations.ts` owns those pure rules, explicit
  validation/no-op results and semantic selection intents. App dispatches pure
  closures to the existing ProjectBag reducer, which uses `state.project`.
  A post-commit receipt effect owns errors and existing semantic navigation;
  replacement-session/workspace guards reject obsolete receipts.
- No new project store, universal GraphAction, command bus, host command, format,
  Mapping write policy or execution controller. Preview invalidation stays with
  existing navigation/controller integration.

## Tested contracts / limits

Frozen snapshot units cover deep local dependency scrub, external targets with
the same object ID, standalone Source retention, focus/canvas cleanup, missing
delete no-op, invalid/duplicate IDs, JOIN append/upsert/empty keys, all six root
families, move guards, invalid indices, step no-ops and sequential edits.
Electron exercises real canvas connections and committed JOIN selection,
batched append/replace/move/remove, batched append/delete, other-owner retention
and all pre-existing Inspector draft checks.

Deletion remains structural, not a cascade or arbitrary SQL repair. Rootless
surviving queries may need user repair. SQL placeholders, saved outputs and map
authoring metadata are not automatically rewritten. Independent Sources remain
catalog entries. Derive and remove-edge are deliberately deferred; this slice
does not claim every graph-related App handler extracted.

## Verification

Evidence directory (local, not durable): `/tmp/opencode/pr01-query-editing/`.

- Units: PASS, 41 files; final repeat also PASS (`unit.log`, `unit-final.log`).
- Rust workspace: PASS (`cargo.log`); no Rust changes in this PR.
- Initial build: FAIL on TypeScript callback narrowing for an external target.
  Fixed by binding the narrowed target before the callback. Later Electron
  entry-point builds pass; final ordinary production build PASS
  (`build-production-final.log`; existing large-chunk warning).
- Initial focused Electron: 7 passed / 1 failed (`electron-focused.log`).
  Canvas JOIN did not append. Diagnostic rerun: 2 passed / 1 failed
  (`electron-editing-rerun.log`). Screenshot inspection found our adapter
  incorrectly treated `parseTargetKey(localId) === null` as an invalid local
  target. That helper parses **only external keys**. Fixed by preserving local
  IDs while decoding external keys. No staleness guard was removed or relaxed.
- Final focused Electron: PASS, all 3 new scenarios (`electron-editing-fixed.log`).
- Full rebuilt Electron: PASS, **70 passed / 2 skipped**, no retries, 4.6 minutes
  (`electron-full.log`). Only PostgreSQL cases skipped without DSN. Host and UI
  rebuilt by the entry point; `target/release/dwh-host` selected.
- `git diff --check`: PASS. Merged capability:
  `openspec/specs/query-graph-editing/spec.md`.

## Smoke / demo verdict

Manual interactive smoke: NOT RUN. Automated Electron is not a human pass.
Reproducible manual smoke: open a disposable project, drag a peer into a Query,
check the newly selected JOIN, add/apply/move a Filter, delete a referenced
Query, Save As and reopen; retain Sample labeling and independent Mapping drafts.
PR-00's separate full own-data/restart/packaging/user-metric gaps remain explicit.

Demo verdict: automated baseline GREEN and ordinary production UI built; not a
human/portable-release sign-off. No packaging or independent user trial claimed.
PR-02 may proceed under the owner's explicit sequential authorization.
