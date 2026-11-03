# Tasks — keymap-stewardship-shapes

## Spec lock
- [x] Review ADR-0028 Proposed → **Accepted**
- [x] Lock inclusive/exclusive policy: half-open `[from, to)` with NULL to = open
- [x] Accept ADR-0028

## Slice A — attrs parity
- [x] Seed create/edit: add/remove attrs; CSV header round-trip
- [x] Ref / seed editor parity with source `editable_columns`
- [x] Tests: export + sync with reason column; Apply ignores attrs

## Slice B — range SCD
- [x] IR: time mode + valid_from/valid_to column names
- [x] Editor overlap/gap validation (validate on KeyMapDef)
- [x] Temporal ApplyKeyMap preview + dbt export (as_of_column + half-open)
- [ ] Demo fixture (optional follow-up)

## Close
- [x] Merge deltas → `openspec/specs/keymap-stewardship-shapes/`
- [x] Update `openspec/README.md` / `AGENTS.md`
