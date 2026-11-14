# Unified Batch Tuple Matching

## Why

Batch Auto's scalar/fuzzy-slot choices can collapse contextual identities. Batch
review needs complete ordered Join tuples and one explicit decision per source,
then one all-or-nothing Mapping + Apply publication, not incremental editor fills.

## Scope

Document the implemented **Find Matches** replacement for the primary Join Lens
scalar/composite Auto UI: any positive tuple arity, shared fuzzy/manual/LLM review,
explicit selection and draft acceptance, private preparation and guarded atomic
commit, incompatible/dirty/stale refusal, numeric caps and honest search limits.
Decision: [ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md).

No code/test changes, Rust scorer changes, paid-model integration, new storage or
project format, automatic fuzzy Join, or MatchingWorkspace/Suggest Right
implementation changes. Do not rewrite historical change documents.

## Contract changes

- Add [batch tuple contract](specs/unified-batch-tuple-matching/spec.md).
- Modify [composite Auto contract](specs/keymap-composite-auto/spec.md) and
  [in-place confirmation contract](specs/join-lens-in-place-confirm/spec.md).
- Add narrow current-policy cross-references to prior ADRs and merged specs;
  contextual Matching remains a separate tool.

## Status and review

Implemented; this change records the delivered behavior retrospectively, not a
claim that this new proposal preceded implementation. Review order is proposal
→ specs → [design](design.md) → [tasks](tasks.md).
Contracts are merged into [merged specs](../../specs/unified-batch-tuple-matching/spec.md).
[Report](report.md) separates supplied verified results, source-level evidence,
known failures, and unverified integrations. Parent review/final validation is
still pending; no comprehensive unrelated regression claim is made.
