# OpenSpec

Spec-driven changes for DWHForge Query. Product decisions remain in `docs/` (DESIGN, ADR). OpenSpec tracks **behavior deltas** for a change before/while implementing.

```text
openspec/
  changes/<id>/
    proposal.md    # why / scope
    design.md      # how (optional for small changes)
    specs/...      # ADDED/MODIFIED requirements + scenarios
    tasks.md       # implementation checklist
  specs/           # (optional) archived source-of-truth after merge
```

Active changes:

- [`changes/return-and-edit-foundation/`](changes/return-and-edit-foundation/) — seeds → safe re-export → e2e
- [`changes/join-key-mapping/`](changes/join-key-mapping/) — KeyMap / NormalizeKey / near-miss ([ADR-0020](../docs/adr/0020-join-key-mapping.md))

Review order: proposal → specs → design → tasks. Implement only after that review (`openspec apply` / agent apply).
