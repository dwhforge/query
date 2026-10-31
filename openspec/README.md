# OpenSpec

Spec-driven changes for DWHForge Query. Product decisions remain in `docs/` (DESIGN, ADR). OpenSpec tracks **behavior deltas** for a change before/while implementing.

**Agents:** required workflow is in [`AGENTS.md`](../AGENTS.md) and [`.cursor/rules/adr-openspec.mdc`](../.cursor/rules/adr-openspec.mdc) (`alwaysApply`).

```text
openspec/
  changes/<id>/
    proposal.md    # why / scope
    design.md      # how (optional for small changes)
    specs/...      # DELTA: ADDED/MODIFIED requirements + scenarios
    tasks.md       # implementation checklist
  specs/           # ARCHIVED SoT: merged capability specs after apply/archive
```

- **While building:** edit `changes/<id>/specs/<capability>/spec.md`.
- **When the change is finished:** merge those deltas into `specs/<capability>/spec.md` (create the tree if missing). **Completed changes must merge here** — not left only under `changes/`.
- Do not confuse with [`docs/SPEC.md`](../docs/SPEC.md) (product IR overview).

Active changes:

- [`changes/return-and-edit-foundation/`](changes/return-and-edit-foundation/) — seeds → safe re-export → e2e
- [`changes/join-key-mapping/`](changes/join-key-mapping/) — KeyMap / NormalizeKey / near-miss ([ADR-0020](../docs/adr/0020-join-key-mapping.md))
- [`changes/app-options-recent/`](changes/app-options-recent/) — Options + Open Recent ([ADR-0021](../docs/adr/0021-app-options-recent-projects.md))

Review order: proposal → specs → design → tasks. Implement only after that review (`openspec apply` / agent apply).
