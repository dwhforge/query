# Stabilization report — ADR-0026–0033

**Status:** in progress (scoped path: Phases 0–3; 4–6 gated follow-ups)  
**Reviewed baseline SHA:** `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6`  
**Tested SHA (Phase 0 start):** `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6`  
**Branch:** `feature/mapping_wow`  
**Prepared:** 2026-11-04  
**Scope agreement:** full unit inventory + KeyMap binding isolation + atomic persistence; Phases 4–6 deferred as gated follow-ups.

## Environment

| Tool | Version |
|------|---------|
| OS | Linux 6.8.0-88-generic x86_64 |
| Node | v20.20.2 |
| npm | 10.8.2 |
| rustc | 1.98.0 (stable-x86_64-unknown-linux-gnu) |
| cargo | 1.98.0 |

## Git reconcile

| Item | Value |
|------|-------|
| HEAD at start | `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6` |
| vs reviewed SHA | identical |
| Worktree at Phase 0 | clean |
| Intervening commits | none |

## Test inventory (discovered)

### TypeScript `*.test.ts` (11) — all in `test:unit` after Phase 1

| File | Notes |
|------|-------|
| `src/lib/hostRpc.test.ts` | production `unpackInvokeReply` |
| `src/lib/requestGen.test.ts` | |
| `src/lib/mappingCheck.test.ts` | |
| `src/app/keyMap/service.test.ts` | |
| `src/app/mappingChecks/service.test.ts` | |
| `src/lib/mappingQuality.test.ts` | was stale vs 24-key cap — fixed |
| `src/lib/keyMapDirty.test.ts` | stub → points at edit store |
| `src/lib/keyMapEditStore.test.ts` | |
| `src/lib/keyMapFindApply.test.ts` | |
| `src/lib/joinMapEffect.test.ts` | |
| `src/lib/joinAutoDiag.test.ts` | |

No `*.test.tsx` found. Electron IPC smoke: **release gate / not run** (no disposable harness in this pass).

### Rust

- Lib unit tests: `dwh-pipeline`, `dwh-engine`, `dwh-host`
- Integration: `crates/dwh-host/tests/mapping_quality.rs` (not in default CI `--lib` gate)

### CI trigger note

`.github/workflows/ci.yml` runs on `pull_request` and pushes to `main`/`master` only. Feature-branch push alone does **not** run CI.

## Command matrix (Phase 0 @ a62ff1f)

| Command | Result | Exit | Notes |
|---------|--------|------|-------|
| `npm ci` | passed | 0 | |
| `npm run test:unit` | passed | 0 | then only 5 files |
| `npm run build` | passed | 0 | |
| `cargo test -p dwh-pipeline --lib` | passed | 0 | |
| `cargo test -p dwh-engine --lib` | **failed** | 101 | `session_limits::apply_settings_roundtrip` env race |
| `cargo test -p dwh-host --lib` | passed | 0 | |
| `npm run types:check` | passed | 0 | then git-diff only |
| `cargo build -p dwh-host --release` | passed | 0 | |

Logs: `docs/stabilization/logs/`.

## Phase 1 evidence (post-fix)

| Command | Result | Exit | Notes |
|---------|--------|------|-------|
| `npm run test:unit` | passed | 0 | **11/11** files; pinned esbuild binary |
| `bash scripts/check-generated-types.sh` | passed | 0 | inventory + content vs clean temp export |
| `cargo test -p dwh-engine --lib` | passed | 0 | after ENV_LOCK fix |
| Electron IPC smoke | **not run** | — | documented release gate |

## Resolved / open

| Item | State |
|------|-------|
| Typed MappingCheck / bindings / DTO satisfies / IPC unpack | verified (unit) |
| Strict format_version / source strip | verified prior; persistence atomicity Phase 3 |
| Full TS unit inventory | **done** |
| Strict generated-types freshness | **done** |
| `dwh-engine` env-race flake | **fixed** |
| KeyMap binding isolation / late-ack | **in progress** |
| Atomic project write | open (Phase 3) |
| Phases 4–6 | gated follow-ups |

## Failures discovered

1. **`session_limits::apply_settings_roundtrip`** — parallel tests mutated process `DWH_DUCKDB_MEMORY`; resolved to auto RAM (`21852MB`) instead of `2GB`. Fix: `ENV_LOCK` + restore guards.
2. **`mappingQuality.test.ts`** — fixture used 30 keys so `"a'b"` fell outside the 24-key inspect cap; assertion looked like a quote bug. Fix: separate quote vs cap assertions.
3. **KeyMap rebind via editor `onChange`** — cleared only `map`, kept `contentHash`/`dirtyDelta`/`saveApi`; merge on binding change unioned previous relation rows before reset. Fix in Phase 2.

## Fixes applied

- Phase 0/1: report + logs; engine test isolation; discover-all unit runner (no npx esbuild); `check-generated-types.sh`; hostRpc nested-domain / snake_case / transport cases; mappingQuality fixture.
- Phase 2 (in flight): `applyKeyMapTabMapChange`, rebind replaces rows (no union), refuse rebind while Save busy, late-ack binding fingerprint, deletedFroms/Parts not resurrected, editor storage disabled while saving.

## Remaining limitations

- No Electron `ipcMain→preload→renderer` smoke executed this pass.
- Seed/ref drafts without a non-empty `dirtyDelta` are not protected across refresh (editor normally emits delta via `toDelta`).
- Multi-file project/connections/secrets crash consistency still not ACID (Phase 3 documents, does not claim).
- Phases 4–6 not started under agreed scope cut.
