# Stabilization report — ADR-0026–0033

**Status:** scoped path complete (Phases 0–3); Phases 4–6 gated follow-ups  
**Reviewed baseline SHA:** `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6`  
**Tested SHA (start):** `a62ff1f35f0d7b9cb4f9829b4e2abec471d16ba6`  
**Tested SHA (this report tip):** see `git log -1` on branch after commits below  
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
3. *(pending)* — Atomic project/secrets/connections writes + future-format refuse  

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

### After Phases 1–3 (focused re-runs)

| Command | Result | Exit | Notes |
|---------|--------|------|-------|
| `npm run test:unit` | passed | 0 | **11/11** |
| `npx tsc --noEmit` | passed | 0 | |
| `bash scripts/check-generated-types.sh` | passed | 0 | |
| `cargo test -p dwh-engine --lib` | passed | 0 | |
| `cargo test -p dwh-host --lib atomic_fs::` | passed | 0 | |
| `cargo test -p dwh-host --lib secrets_io::` | passed | 0 | |
| Electron IPC smoke | **not run** | — | release gate |
| Phase 4–6 suites | **not run** | — | deferred |

Logs: `docs/stabilization/logs/`.

## Test inventory

All 11 `src/**/*.test.ts` discovered and executed by `npm run test:unit` (pinned esbuild binary; no `npx` download). No `*.test.tsx`. CI still triggers on PR / main|master only — feature-branch push alone is not evidence of CI.

## Failures discovered → fixes

| Failure | Fix |
|---------|-----|
| `session_limits::apply_settings_roundtrip` flake (`21852MB` vs `2GB`) | `ENV_LOCK` + restore guards |
| `mappingQuality.test.ts` quote assert vs 24-key cap | split quote vs cap fixtures |
| Unit runner omitted 6 files; used `npx esbuild` | discover-all + platform binary |
| `types:check` missed untracked generated files | `check-generated-types.sh` inventory+content |
| KeyMap rebind unioned old relation rows; late WH ack | `applyKeyMapTabMapChange`, fingerprint settle |
| `fs::write` project/secrets/connections | `atomic_fs::atomic_write`; refuse future format |

## Remaining limitations / debt

- **Not ACID across files:** project publish + secrets/connections remain separate; crash between them can leave stale credentials while the project file stays parseable.
- **Electron IPC smoke** not executed (documented release gate).
- **Phases 4–6** (races, workflow/temporal/export e2e, perf baseline) not started.
- Seed/ref drafts without a non-empty `dirtyDelta` are not protected across refresh.
- Multi-process / network-FS rename behavior not claimed safe.
- Host integration test `mapping_quality.rs` not in default `--lib` CI gate.

## Migration / rollback

- No `format_version` bump.
- Atomic write is transparent to file schema.
- Future-format on-disk projects: save now **refuses** instead of stamping current version over them.
- Upgrade `.bak`: first backup kept; retry does not overwrite existing `.bak`.
