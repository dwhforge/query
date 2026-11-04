# Query-based mapping create (v0.3.1)

## Why

Users need to create a seed KeyMap from two local queries (keys + optional last-Fields restore) without implying Apply/Join/Check/export.

## In scope

- Plan / validate / commit helpers (all-or-nothing Project fold)
- Optional typed `authoring_context` (ADR-0034); no format_version bump
- Last-Fields-only restore; direct query consumers warning
- Thin wizard → existing KeyMap editor handoff

## Out of scope

- Prepared copies, lineage tour, suggest/reconcile, Lens/Check, DDL, post-commit undo, Phases 4–6

## ADR

[ADR-0034](../../../docs/adr/0034-keymap-authoring-context.md)
