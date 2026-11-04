# Report — query-based mapping create v0.3.1

**Tested tree:** working tree on `feature/mapping_wow` (e2e hardening: barrier, isolation, host rebuild, hook gate)  
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
- Playwright Electron smoke (experimental API): 6 scenarios, isolated per test

## E2E hardening (review P1/P2)

- Describe hold via `e2eBridge` + `invoke` (not `window.dwh.invoke` monkey-patch); Cancel/✕ enabled while busy
- Barrier: arm → Next → wait started → close → reopen → release → assert stale ignored
- Fresh Electron + materialized project per test; explicit discard dialog only where draft is filled
- Always `cargo build -p dwh-host --release` before e2e (opt-out: `DWH_E2E_SKIP_HOST_BUILD=1`); log chosen host path (portable-beside-app warning)
- `__dwhE2e*` hooks only when UI built with `DWH_E2E=1` (not `DWH_ELECTRON_BUILD` alone)
- Stronger asserts: tab count, post-commit Fields columns, confirm-during-drift refuse, JSON round-trip of `ToKeyMap.authoring_context`

## Commands run

```bash
npx tsc --noEmit
npm run test:unit
npm run test:e2e:electron                        # 6 passed (~15s, isolated apps)
npm run test:e2e:electron -- -g "cancel during"  # alone
npm run test:e2e:electron -- -g "upstream def"   # alone
```

## Electron smoke (`npm run test:e2e:electron`)

Real stack: Electron + release `dwh-host` + DuckDB describe. Fixture CSVs with absolute paths. Trace on failure → `test-results/`.

1. Create without Fields patches → exactly one editor tab + one KeyMap  
2. Source + target restore → Fields columns contain restored names after commit  
3. Include catalog `product_id` restore → retarget → review without orphan Fields patch  
4. Cancel/✕ during held describe → reopen ignores stale reply  
5. Confirm with held describe + upstream def patch mid-flight → refuse, draft kept, no map  
6. Source key `to` → `to_2` → save → parse ToKeyMap authoring_context → reopen project

Playwright Electron API is **experimental** — pin `@playwright/test` carefully.

## Limitations

- Menubar File→Open/Save races under Playwright; smoke uses `__dwhE2e*` hooks (E2E build only) that still call real `load_project` / `save_project` IPC
- No post-commit undo; seed storage only
- Older app builds may drop `authoring_context` on re-save (ADR-0034)
- Electron e2e not yet a required CI gate (add when agents have display/xvfb)
- Per-test app launch is slower than serial shared state; preferred for correctness

## OpenSpec

Change remains under `openspec/changes/query-based-mapping-create/` until merge into `openspec/specs/`.
