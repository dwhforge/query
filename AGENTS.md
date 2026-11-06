# Agent instructions — DWHForge Query

All coding agents (Cursor and others) must follow this.

## ADR + OpenSpec (required)

Product decisions and behavior contracts are not optional context.

| Layer | Path |
|-------|------|
| Architecture decisions | [`docs/adr/`](docs/adr/) |
| Product / IR | [`docs/DESIGN.md`](docs/DESIGN.md), [`docs/SPEC.md`](docs/SPEC.md) |
| In-flight changes | [`openspec/changes/<id>/`](openspec/changes/) — proposal, delta `specs/`, design, tasks |
| Merged SoT | [`openspec/specs/`](openspec/specs/) — **completed** changes must land here |
| Index | [`openspec/README.md`](openspec/README.md) |

**Done means merged:** when an OpenSpec change is finished, merge `changes/<id>/specs/` into `openspec/specs/`. Do not leave completed work only under `changes/`.

`docs/SPEC.md` ≠ `openspec/specs/` (product IR vs OpenSpec capability contracts).

**Rules (full text):** [`.cursor/rules/adr-openspec.mdc`](.cursor/rules/adr-openspec.mdc) (`alwaysApply`).

### Short checklist

1. Before non-trivial work: read **ADRs**, **`openspec/specs/`**, and any active OpenSpec change.
2. New product decision → **ADR**.
3. Behavior change → update change **proposal / specs / tasks**; stay in scope.
4. Review order: proposal → specs → design → tasks.
5. Change finished → **merge into `openspec/specs/`**.
6. Do not contradict **Accepted** ADRs.

### Active OpenSpec changes

- `openspec/specs/postgres-schema-import/` — ADR-0040 Postgres schema import (merged)
- `openspec/specs/help-lab/` — ADR-0039 Help Lab catalog + recon flagship (merged)
- `openspec/specs/keymap-apply-*` — ADR-0038 ApplyPlan / prepare-validate-execute (merged)
- `openspec/specs/query-backed-keymap/` — ADR-0036 query-backed KeyMap SoT (merged)
- `openspec/specs/keymap-multi-output-*` — ADR-0037 multi-output KeyMap (merged)
- `openspec/changes/query-based-mapping-create/` — ADR-0034 query-based KeyMap create (v0.3.1)
- `openspec/changes/return-and-edit-foundation/` — ADR-0018 foundation
- `openspec/changes/join-key-mapping/` — ADR-0020 KeyMap / near-miss
- `openspec/changes/app-options-recent/` — ADR-0021 Options + Open Recent
- `openspec/specs/dbt-setup-onboarding/` — ADR-0023 first-run / Options dbt install (merged)
- `openspec/specs/keymap-composite-*` — ADR-0024 composite From + multi-key Join Auto (merged)
- `openspec/specs/project-references/` — ADR-0025 references between saved projects (merged)
- `openspec/specs/mapping-quality-overview/` — ADR-0026 Help-lab overview (merged)
- `openspec/specs/mapping-quality-checks/` — ADR-0027 MappingCheck / CheckRun closed loop (merged)
- `openspec/specs/typed-wire-contract/` — ADR-0029 ts-rs / typed HostError (merged)
- `openspec/specs/project-format-version/` — ADR-0030 project `format_version` (merged)
- `openspec/specs/execution-lifecycle/` — ADR-0031 DuckDB ownership / cancel / stale replies (merged)
- `openspec/specs/ui-host-decomposition/` — ADR-0032 checks / KeyMap / host commands (merged)
- `openspec/specs/mapping-data-plane/` — ADR-0033 source maps without row bodies (merged)
- `openspec/specs/keymap-stewardship-shapes/` — ADR-0028 attrs + optional range SCD (merged)
