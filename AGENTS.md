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

- `openspec/changes/return-and-edit-foundation/` — ADR-0018 foundation
- `openspec/changes/join-key-mapping/` — ADR-0020 KeyMap / near-miss
- `openspec/changes/app-options-recent/` — ADR-0021 Options + Open Recent
