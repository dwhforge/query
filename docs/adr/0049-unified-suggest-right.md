# ADR-0049 — Unified Suggest Right uses complete Join tuples

## Status

Accepted — 2026-11-14.

## Context

ADR-0024 introduced composite From tuples but legacy composite search scores one
designated fuzzy slot. ADR-0037 supplies multi-output values and explicit Apply
bindings. Suggest Right previously required a per-column choice and could create
a scalar alias where the user's intent was contextual. Search scope and Mapping
scope must not be confused.

## Decision

- Suggest Right automatically uses every ordered Join ON pair for any positive
  arity. One-field matching is the same operation as multi-field matching.
- Extend the existing fuzzy command with an optional tuple request. Reuse the
  shared Jaro-Winkler field scorer across all aligned fields, retaining per-field
  scores. Do not require equality of non-designated fields. Exact tuples score
  fully; fuzzy similarity is advisory, never an automatic confirmation.
- Candidate identities are nullable arrays, not joined display strings. Candidates
  are grouped real right tuples with occurrence counts. Duplicate right rows
  remain visible and can still multiply the eventual Join, not the Mapping Apply.
- LLM receives complete source/candidate tuples and ordered column pairs. Its
  structured response must match the exact source and an entire allowed target
  actually included in the prompt. LLM cannot invent combinations of fields.
  Preserve configured-provider host permissions and explicit user selection.
- Store the complete source in existing From columns/parts and the complete
  target in existing output columns/values. Bind every output to its aligned
  left Join column through the existing Apply review/prepare/validate workflow.
  Do not alter Join execution directly or introduce a separate Mapping entity.
- Reuse a compatible static seed Mapping or create one. Do not reshape a scalar,
  externally backed, or range Mapping silently. Conflicting outputs and duplicate
  From tuples block insertion; unsaved editor changes are not overwritten.
- Preserve legacy Auto's explicit per-column/composite options. The tuple request
  cannot be mixed with those options. Saved project formats remain unchanged.
- Invalidate retrieval, selection, and LLM replies when their context changes.
  Null and blank/whitespace-only parts are displayed distinctly and blocked at
  Mapping confirmation because ready Mapping cannot safely represent them.
  Significant whitespace and the literal ∅ are not normalized into other values.

## Bounded retrieval

The existing 200-distinct-key bound also bounds tuple retrieval. Totals and
truncation are explicit. Manual search searches retrieved tuples, not the entire
warehouse. Prompt budgeting may further restrict the LLM allowlist. These limits
are not limits on Join arity. Dataset-wide search/pagination is not added here.

## Consequences and validation

The ABC/UK alias cannot rewrite ABC/US. Several differing fields are supported in
one Mapping row. Existing scalar maps and Auto retain their contracts. Live Join
tuple Mapping is deliberately unavailable in frozen Check remap.

Contract: [unified Suggest Right](../../openspec/specs/unified-suggest-right/spec.md).
Change and verification: [change record](../../openspec/changes/unified-suggest-right/report.md).
This extends ADR-0024's search UI policy using ADR-0037 outputs and preserves
ADR-0042's explicit confirmation boundary; fuzzy Join ON remains forbidden.
