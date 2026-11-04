# Report — query-based mapping create v0.3.1

**Tested tree:** working tree on `feature/mapping_wow` (post-review hardening + Electron smoke)  
**Recorded SHA at last unit/Rust run:** `926483be4ac466435857c6a658e1d28d1170630e` (plus subsequent uncommitted fixes)  
**ADR:** [0034](../../../docs/adr/0034-keymap-authoring-context.md)  
**Date:** 2026-11-04

## Delivered

- Optional `KeyMapDef.authoring_context` (Rust SoT + ts-rs generated TS); **no** `format_version` bump
- Pure plan / validate / commit with `applied|stale|error` + `opId`
- Last-Fields restore (source + target); pair change prunes orphan restores
- Schema evidence binds query + known upstreams (incl. CustomSql / hyphenated `{{query:lookup-v2}}`)
- Observed evidence vs planned output separation; live re-describe before dispatch
- Physical From/To uniqueness (`to` / `TO` → `to_2`); Rust validate rejects collisions
- Thin wizard → existing KeyMap editor (no WH Save on create)
- Playwright Electron smoke (experimental API): 6 scenarios green

## Review hardening

- Schema evidence + basis fingerprints; commit refuses upstream drift
- Evidence stays observed; builder computes planned output for From/To
- Live re-describe + digest check before dispatch; describe generation guards
- Symmetric target Fields restore; workspace change keeps draft
- `restoresForPair` on source/target change + builder
- `KeyMapAuthoringContext` via `npm run types:generate`
- Placeholder grammar matches Rust `extract_query_placeholders` (not `[A-Za-z0-9_]+`)

## Commands run

```bash
npm run types:generate
npx tsc --noEmit                                 # exit 0
npm run test:unit                                # 12 files ok (incl. mappingCreate)
cargo test -p dwh-pipeline authoring_context     # 3 passed
npm run test:e2e:electron                        # 6 passed (~8.6s after UI build)
```

## Electron smoke (`npm run test:e2e:electron`)

Real stack: Electron + release `dwh-host` + DuckDB describe. Fixture CSVs with absolute paths. Trace on failure → `test-results/`.

1. Create without Fields patches → editor tab once  
2. Source + target restore → both Fields diffs → create  
3. Back → change target after restore → review without orphan restores  
4. Cancel during delayed describe → reopen ignores stale reply  
5. Upstream def change after review → notice, draft kept, no map  
6. Source key `to` → review shows `to_2` → create → save keeps `authoring_context`

Playwright Electron API is **experimental** — pin `@playwright/test` carefully.

## Limitations

- Menubar File→Open/Save races under Playwright; smoke uses `__dwhE2eOpenProject` / `__dwhE2eSaveProject` hooks that still call real `load_project` / `save_project` IPC
- No post-commit undo; seed storage only
- Older app builds may drop `authoring_context` on re-save (ADR-0034)
- Electron e2e not yet a required CI gate (add when agents have display/xvfb)

## OpenSpec

Change remains under `openspec/changes/query-based-mapping-create/` until merge into `openspec/specs/`.
