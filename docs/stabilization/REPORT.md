# Stabilization report — ADR-0026–0033

**Status:** Phases 0–3 acceptance closed after persistence/review fixes; Phases 4–6 gated follow-ups  
**Reviewed baseline SHA:** `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6`  
**Tested SHA (start):** `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6`  
**Tested functional tip:** `436c9d5`
**Branch:** `feature/mapping_wow`  
**Prepared:** 2026-11-04  
**Scope agreement:** full unit inventory + KeyMap binding isolation + atomic persistence; Phases 4–6 deferred.

## Environment

| Tool | Version |
|------|---------|
| OS | Linux 6.8.0-88-generic x86_64 |
| Node | v20.20.2 |
| npm | 10.8.2 |
| rustc | 1.98.0 (stable-x86_64-unknown-linux-gnu) |
| cargo | 1.98.0 |

## Commits (this pass)

1. `55be262` — Stabilize test gates: full unit inventory, types freshness, engine env isolation  
2. `148774b` — Isolate KeyMap tab state across warehouse binding changes  
3. `db975b2` — Atomic project/secrets/connections writes + future-format refuse  
4. *(review)* — Temp mode at create, real fault-injection tests, durability wording, seed/ref `localDraft`

## Durability guarantee (explicit)

| Claim | Status |
|-------|--------|
| No partially overwritten destination JSON | **yes** — temp + rename |
| Pre-rename failure leaves previous bytes | **yes** — verified via injected faults on production path |
| Secrets temp confidential from first byte (Unix `0o600` at `open`) | **yes** |
| Replace preserves prior project mode when mode not overridden | **yes** |
| Directory-entry durable after power loss | **no** — parent `sync_all` is best-effort; failure → `PostCommitDirSync` (content already published) |
| Multi-file project+secrets+connections ACID | **no** |

## Command matrix

### Phase 0 @ a62ff1f

| Command | Result | Exit | Notes |
|---------|--------|------|-------|
| `npm ci` | passed | 0 | |
| `npm run test:unit` | passed | 0 | then only 5 files |
| `npm run build` | passed | 0 | |
| `cargo test -p dwh-pipeline --lib` | passed | 0 | |
| `cargo test -p dwh-engine --lib` | **failed** | 101 | env race → fixed |
| `cargo test -p dwh-host --lib` | passed | 0 | |
| `npm run types:check` | passed | 0 | then git-diff only |
| `cargo build -p dwh-host --release` | passed | 0 | |

### Full gate after review fixes

| Command | Result | Exit | Notes |
|---------|--------|------|-------|
| `npm run test:unit` | passed | 0 | **11/11** |
| `npx tsc --noEmit` | passed | 0 | |
| `bash scripts/check-generated-types.sh` | passed | 0 | |
| `npm run build` | passed | 0 | |
| `cargo test -p dwh-pipeline --lib` | passed | 0 | |
| `cargo test -p dwh-engine --lib` | passed | 0 | |
| `cargo test -p dwh-host --lib` | passed | 0 | incl. atomic fault + mode tests |
| Electron IPC smoke | **not run** | — | release gate |
| Phase 4–6 suites | **not run** | — | deferred |

Logs: `docs/stabilization/logs/` (gitignored).

## Failures discovered → fixes

| Failure | Fix |
|---------|-----|
| Engine env race | `ENV_LOCK` |
| Unit inventory / esbuild / types freshness | discover-all runner + `check-generated-types.sh` |
| KeyMap rebind / late ack | binding fingerprint + refuse busy rebind |
| Secrets temp chmod-after-write | `OpenOptionsExt::mode` at create |
| Fake pre-commit test | `AtomicWriteFault` injection on production path |
| Seed/ref drafts without `dirtyDelta` | session `localDraft` + merge protect |
| Seed/ref delete resurrect / mid-save clear | freeze union while draft; `settleSeedDraftAfterSave` |

## Remaining limitations / debt

- Multi-file crash consistency still not ACID (documented).
- Dir sync best-effort / `PostCommitDirSync` (logged; not rolled back).
- Electron IPC smoke not executed.
- Phases 4–6 not started.
- Multi-process / network-FS rename not claimed safe.

## Migration / rollback

- No `format_version` bump.
- Atomic write transparent to schema.
- Future on-disk format: save refuses overwrite.
- First upgrade `.bak` retained on retry.
