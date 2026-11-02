# Tasks — keymap-composite

## 1. IR + emit
- [x] 1.1 Soft-migrate `from_column`→`from_columns`, `from`→`from_parts`, `column`→`columns` (+ optional `output_column`)
- [x] 1.2 Validate tuple uniqueness; arity alignment
- [x] 1.3 Emit ApplyKeyMap multi-ON (DuckDB + Postgres) + VALUES path
- [x] 1.4 Unit tests: legacy load, composite emit, duplicate tuple

## 2. Export / sync / source
- [x] 2.1 Seed write/parse composite headers
- [x] 2.2 Sync seed→KeyMap + Apply snapshots
- [x] 2.3 Source read/write upsert by From tuple; bind wizard N From cols

## 3. Auto / Suggest
- [x] 3.1 Remove hard-disable-only path; mode picker API/UI (per-column)
- [x] 3.2 Per-column fuzzy on chosen join key index
- [x] 3.3 Composite-map suggest (exact side cols + fuzzy primary); Accept → from_parts
- [x] 3.4 No glued-separator From

## 4. UI
- [x] 4.1 KeyMapEditor multi From columns + grid
- [x] 4.2 Apply dialog columns / output
- [x] 4.3 Suggest Right/Auto per-column chooser + composite-map mode

## 5. Labs + docs
- [x] 5.1 `scripts/examples` composite offer lab + Help demo
- [x] 5.2 keymap-workflows / userGuide / DEMOS; note POS+day = per-column
- [x] 5.3 Merge deltas → `openspec/specs/`; link ADR-0024

## 6. Done
- [x] 6.1 E2E: arity-1 regression + composite seed Apply + Auto both modes on multi-key Join
