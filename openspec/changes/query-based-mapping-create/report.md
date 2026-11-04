# Report — query-based mapping create v0.3.1

**Baseline HEAD:** `8a76cce7f721fe701913e7fc71346833dba4dcb4`  
**ADR:** [0034](../../../docs/adr/0034-keymap-authoring-context.md)  
**Date:** 2026-11-04

## Delivered

- Optional `KeyMapDef.authoring_context` (Rust + TS); **no** `format_version` bump
- Pure plan / validate / commit (`src/app/mappingCreate/`) with `applied|stale|error` + `opId`
- Last-Fields restore only when last step is `SelectColumns`
- Thin wizard → existing KeyMap editor (no WH Save on create)
- Explorer: **Create from data** (◇) next to blank **New mapping** (+)

## Commands run

```bash
npx tsc --noEmit                         # exit 0
npm run test:unit                        # 12 files ok (incl. mappingCreate)
cargo test -p dwh-pipeline authoring_context  # 2 passed
```

## Limitations

- No Electron UI smoke in this environment (manual: Mappings → Create from data → review → Create and open)
- No post-commit undo
- Seed storage only; create does not Apply / Join / Check / Lens / export / disk-save
- Older app builds may drop `authoring_context` on re-save (accepted in ADR-0034)

## OpenSpec

Change remains under `openspec/changes/query-based-mapping-create/` until merge into `openspec/specs/`.
