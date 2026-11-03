# Mapping quality checks — closed loop

Close the stewardship loop that ADR-0026’s lab overview only sketched: choose a
meaningful group on the user’s KeyMap, investigate the cohort in Join Lens, apply
an explicit remap through existing KeyMap Save/Apply, then recompute with a
comparable Δ.

## Why

Coverage and bounded samples do not constitute a return-worthy workflow. Without a
durable check object and attributed recompute, the overview remains a Help
showcase. This change makes the overview the place to select and verify groups;
Join Lens remains the place to understand and fix them ([ADR-0020](../../../docs/adr/0020-join-key-mapping.md)).
Project return-and-edit context: [ADR-0018](../../../docs/adr/0018-return-and-edit.md).

## In scope (v1)

- MappingCheck vs CheckRun (definition vs execution result)
- Overview on the user’s own KeyMap with user-chosen grouping attributes
- Cohort as predicate (not a key list dumped into the UI)
- Open cohort in Join Lens with existing pagination / editing
- Explicit batch remap: freeze From→To + expected KeyMap revision; re-preview if stale
- Distinct “accept links” vs “allow observed difference on the check”
- New CheckRun after remap with attributed Δ (map / inputs / both / limited)

## Out of scope (v1)

- Owners, approvals, tickets, notifications
- New matcher or LLM
- Automatic fuzzy Join ON ([ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md))
- Second mapping store or replacement of KeyMap editor / Join Lens
- Help-lab schema as the only supported attribute model (lab may remain a demo)

## ADR

[ADR-0027](../../../docs/adr/0027-mapping-quality-checks.md) — **Accepted**.
