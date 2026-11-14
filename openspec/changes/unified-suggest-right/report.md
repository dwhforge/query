# Unified Suggest Right — implementation and verification

## Changed areas

- Engine `join_fuzzy` and shared `key_match`: optional structured full-tuple mode,
  grouped occurrence counts, focused source retrieval, all-field scoring.
- Host API: optional tuple request on the existing command; legacy wire remains valid.
- Bridge, FindRightDialog, JoinLens: direct contextual entry; full source/target
  field review, differences, counts, manual search, explicit target selection.
- Tuple/LLM helpers: exact nullable array identity, complete-tuple prompt and
  allowlist validation, stale request/reply guards.
- Tuple Mapping planner, App handoff, KeyMap editor/review: full From/output
  values, explicit aligned output bindings, existing Apply workflow.

## Reused and discovered behavior

Composite From tuples and multi-output values/bindings already support contextual
application and persistence. No new Mapping format or execution implementation was
needed. Legacy composite fuzzy search only scores one selected slot; the optional
tuple mode now composes the existing field scorer across every pair. The old
Suggest Right scalar handoff was insufficient; the new handoff carries both full
arrays and initializes multi-output Apply destinations explicitly.

## Automated verification actually run

- Production frontend build: passed (bundle-size warning remains).
- Frontend unit suite: 46 test files passed; covers 1–5-key tuple confirmation,
  context isolation, multi-output binding, LLM allowlists, stale UI guards.
- Chromium component suite: 9 tests passed with mocked host/LLM responses;
  full-field display/selection, manual search, unsafe values, LLM alongside fuzzy,
  fallback, close/context races. Requires system Chromium override in this environment.
- `cargo test -p dwh-engine -p dwh-pipeline -p dwh-host --lib`:
  325 passed, one ignored performance benchmark, zero failures.
- Host tuple suggest/lifecycle integration tests: 6 passed.
- Existing host mapping-quality integration: one passed.
- Electron tuple Save/Reopen suite: 5 passed, one case per arity 1–5.
- Diff whitespace validation: clean.

## Real data and Save/Reopen outcome

Both host RPC and Electron tests used actual temporary CSVs, real DuckDB execution,
real project Save, process termination, restart, Open, and Join execution. Electron
used existing native-picker bypass hooks, not mocked persistence or search.

The 2-key case uses ABC/UK, ABC/US, XYZ/UK and corresponding right records. Applying
the selected UK tuple leaves US unchanged. Cases with 3–5 keys share the first two
fields and differ in the third. Targets change multiple fields. Right column names
differ and CSV physical column order is reversed. All persisted output values and
bindings survive reopening; Join results before/after reopening agree. Host tests
also retain two independent contextual mapping entries. Apply does not multiply
input rows. These checks are execution/persistence tests, not display-only checks.

## Remaining limits and unverified integrations

- Retrieval is the first 200 distinct right tuples in deterministic order; manual
  search does not query beyond that universe. Truncation and totals are visible.
- LLM prompt budgeting can reduce the candidate allowlist further. Live remote
  model/network quality was not tested; mocked responses test permissions/config
  gating, complete context, validation, fallback reachability, and stale replies.
- NULL, empty, and whitespace-only parts block Mapping with an explanation; literal
  ∅ and significant whitespace are preserved rather than silently converted.
- Contextual handoff reuses compatible static seed maps or creates one; it does
  not reshape scalar/source/ref/range maps. Frozen Check remap refuses this path.
- No live PostgreSQL DSN was configured; environment-gated PostgreSQL tests did
  not exercise a live server. The data smoke tests use CSV and DuckDB, not Parquet.
- Existing staged changes predating this task were preserved; nothing was committed.

## UI polish follow-up verification (2026-11-14)

- Stable preferred 760 × 680 px viewport-bounded shell, pinned header/ranking
  toolbar/footer, internally scrolling review. Existing Options palette and
  styled hover/focus/disabled controls; complete tuple semantics unchanged.
- Prominent Ask LLM to rank candidates remains available alongside fuzzy hits;
  missing provider guidance, disabled reasons, and busy status are visible.
- Search other records disclosure hides the initially repeated manual universe
  while preserving counts, all-field search, and explicit selection.
- `npm run test:unit`: passed (all discovered frontend unit files).
- `npm run build`: passed; existing large-chunk advisory remains.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test
  -c src/components/FindRightDialog.playwright.config.ts`: 12 passed.
  Actual app CSS is loaded through Vite. Geometry checks cover held retrieval,
  fuzzy hits, LLM busy/completion, disclosure/filtering, internal scrolling, and
  pinned controls at 1280 × 900 and 640 × 540. Missing-provider manual selection
  and guidance are covered. Existing stale-context/tuple-safety tests still pass.
- Visually reviewed generated `suggest-right-1280.png` and
  `suggest-right-640.png` under `test-results/suggest-right/`: app-consistent dark
  compact controls, prominent teal ranking action, bounded shell, visible footer.
- Updated Electron tuple test to open the manual disclosure; Electron/backend
  lifecycle suites were not rerun for this UI-only follow-up. No backend or
  Mapping implementation was changed; prior unrelated working-tree work retained.
- UI requirements merged into `openspec/specs/unified-suggest-right/spec.md`.
