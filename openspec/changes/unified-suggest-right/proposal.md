# Unified Suggest Right

## Why

Per-column suggestions lose the context of multi-key Joins. A full candidate in
the UI is insufficient if its saved Mapping becomes a global scalar alias.

## Scope

One Suggest Right flow for 1–N ordered Join pairs; complete real candidate tuples;
Exact/Fuzzy/LLM availability; explicit selection; contextual multi-output seed
Mapping; existing Apply and persistence. Preserve legacy Auto and other Matching
Workspace tools. No new Mapping entity, fuzzy engine, or App-wide refactor.

UI polish follow-up: use the existing dialog visual language, a stable responsive
shell with pinned controls and internal scrolling, a prominent always-visible
LLM ranking action, and a discoverable manual-search disclosure. Backend,
candidate identity, explicit selection, and Mapping semantics remain unchanged.

## Decision and review order

ADR-0049 extends ADR-0024 with ADR-0037 multi-output bindings and preserves
ADR-0042 confirmation. Review proposal → specs → design → tasks.

## Status

Implemented; contract merged into `openspec/specs/unified-suggest-right/spec.md`.
Verification details and explicit limitations are in `report.md`.
