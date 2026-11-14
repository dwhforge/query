# ADR-0050 — Unified Batch Tuple Matching

## Status

Accepted — 2026-11-14. Documents implemented behavior; contract merged into
[unified-batch-tuple-matching](../../openspec/specs/unified-batch-tuple-matching/spec.md).
Review record: [proposal](../../openspec/changes/unified-batch-tuple-matching/proposal.md)
→ [specs](../../openspec/changes/unified-batch-tuple-matching/specs/)
→ [design](../../openspec/changes/unified-batch-tuple-matching/design.md)
→ [tasks](../../openspec/changes/unified-batch-tuple-matching/tasks.md).
Evidence and gaps: [report](../../openspec/changes/unified-batch-tuple-matching/report.md).

## Context

The legacy scalar/composite Auto surface chooses a remap column or fuzzy slot.
That can lose the context that distinguishes two otherwise identical labels.
[ADR-0049](0049-unified-suggest-right.md) already established complete ordered
tuples for single-source Suggest Right. Batch review needs the same identity and
multi-output Mapping, without publishing a partially filled map before Apply is
ready. Fuzzy and model proposals are evidence, not user decisions.

## Decision

1. **Find Matches replaces legacy scalar/composite Auto as the primary Join Lens
   batch UI**, including the former Quick match label in
   [ADR-0044](0044-matching-workspace.md). It uses every ordered left/right Join
   pair for any positive arity, with no slot/mode picker and no scalar fallback.
   This supersedes [ADR-0024](0024-keymap-composite.md) §4 and
   [ADR-0042](0042-join-lens-in-place-confirm.md) §6 for this surface only.
   Legacy Rust scalar/composite commands remain compatible and unchanged.
2. **One queue record is one complete source tuple.** All parts, aligned field
   differences/scores, target occurrence counts, and provenance remain available.
   Targets are real complete right tuples, never field recombinations or glued
   display strings. Duplicate right occurrences warn about eventual Join fan-out;
   they are not multiple Mapping decisions.
3. **No preselection or pre-acceptance.** Every record starts pending with no
   selected target, even for exact or high-scoring candidates. The user selects a
   target, then accepts it in the draft or skips the record. Only **Write Mapping**
   commits accepted decisions. This supersedes ADR-0042 §3. Cancel/dismiss and
   unaccepted proposals do not change the project.
4. **Fuzzy, manual, and optional LLM alternatives share the queue.** LLM remains
   available alongside fuzzy results and for pending records without fuzzy hits.
   Validate exact source and full target arrays against the allowlists actually
   sent. Deduplicate alternatives and retain provenance; later replies cannot
   replace accepted or skipped decisions. LLM never accepts or writes a Mapping.
5. **Prepare privately; publish Mapping + Apply atomically.** Use existing
   [multi-output IR](0037-keymap-multi-output.md) and
   [ApplyPlan](0038-keymap-apply-operation.md), binding each output to its aligned
   left Join column. Validate the entire batch and resulting ready map, resolve
   Apply, and fold it into a private project value before publishing anything.
   A guarded reducer commits that complete value only if the live project is
   still the expected project. Success is acknowledged after reducer commit,
   not after preparation. Any failure leaves Mapping and graph unchanged; no
   editor tab is needed to finish. This is project-state atomicity, not a new
   warehouse transaction or an automatic project-file Save.
6. **Fail closed.** Reuse only a compatible static seed Mapping, or create one
   when eligible. An incompatible map already used by this Join blocks the batch;
   do not silently replace/reshape scalar, source, query, ref, or range maps.
   Differing existing outputs, duplicate From decisions/rows, dirty editor drafts
   or deltas, and a Save in flight block writes. Same-output existing rows are
   no-ops. Frozen Check remap does not support this live-Join tuple path.
7. **Local definition freshness, not external data freshness.** The batch
   fingerprint includes full workspace definitions (including upstream queries,
   maps and bindings), Join target, connections, sources, and project-reference
   context. Object keys are canonicalized; array order remains significant.
   It is **LOCAL ONLY**: connection secrets participate in invalidation, so this
   token must never enter model prompts, logs, telemetry, or persisted drafts.
   Context changes invalidate session/replies; the handler rechecks context and
   the reducer rejects intervening project changes. **External file/database
   content changed in place is not detected by this definition-only fingerprint.**
8. **Exact value identity.** Use the existing
   [tupleMappingBlock()](../../src/lib/joinLensTuple.ts:18) to block NULL, empty,
   and whitespace-only source/target parts with an explanation. Keep them
   distinguishable in review. Significant leading/trailing whitespace and literal
   ∅ retain identity: do not trim, case-fold, or convert display markers into NULL.
   This is a conservative authoring gate, not a change to ADR-0037's stored-value
   semantics, which permit whitespace-only stored strings.

## Caps and limitations

The Rust full-tuple matcher is unchanged from ADR-0049: shared Jaro-Winkler
scores for all aligned fields, equal-weight mean, no designated-slot equality
filter. These are bounded suggestions, not calibrated probabilities.

| Boundary | Implemented limit |
|----------|-------------------|
| Retrieved distinct tuples | 200 per side; totals/truncation remain visible |
| Fuzzy cutoff | 0.88 |
| Initial fuzzy alternatives in UI | 8 per source; omitted count shown |
| Manual browsing | 20 retrieved targets per page; all-field filtering |
| LLM request | At most 4 pending source groups × 12 candidate tuples each |
| Batch prompt | 10,000-character budget; budgeting may reduce either axis |
| Chat history | Last 6 messages, at most 4,000 characters per message |

Manual browsing and LLM do not search beyond the retrieved universe. Focusing a
pending source makes it reachable within the next bounded LLM request. Omitted
groups/candidates and retrieval truncation are not proven non-matches. These
limits are not arity limits, token/currency estimates, or a project-wide run
budget. There is no global one-to-one assignment or durable batch draft restore.

## Compatibility and consequences

- Suggest Right implementation and its single-source workflow remain unchanged.
  ADR-0049's promise to preserve Auto describes its historical scope, not a ban
  on this later primary-UI replacement.
- MatchingWorkspace implementation remains unchanged. Its contextual plan,
  constraints, lifecycle, host trust boundary, budgets, and Save semantics remain
  [ADR-0044](0044-matching-workspace.md)'s separate contract. Sharing LLM use or
  multi-field data does not merge these tools.
- Existing Mapping/Apply persistence and runtime validation remain authoritative;
  no format migration, new storage, fuzzy Join ON, or LLM inside runtime Apply.
- Evidence covers arities 1–5, not every possible arity or connector. CSV/Rust
  execution and cold reopen were verified; Parquet, paid LLM services, and an
  independent MatchingWorkspace run were not. Native engine tuple tests passed
  serially; a parallel attempt crashed with SIGSEGV. See the report for precise
  evidence rather than treating this as comprehensive regression certification.
