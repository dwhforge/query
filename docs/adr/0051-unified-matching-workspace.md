# ADR-0051 — Unified Matching Workspace

## Status

Accepted — architecture approved by the user on 2026-11-15; decision only.
Phase 1 contains no UI or engine implementation and claims no new runtime
verification. Approved implementation packet:
[proposal](../../openspec/changes/unified-matching-workspace/proposal.md),
[delta contracts](../../openspec/changes/unified-matching-workspace/specs/),
[design](../../openspec/changes/unified-matching-workspace/design.md), and
[tasks](../../openspec/changes/unified-matching-workspace/tasks.md).

## Context and explicit supersession

[ADR-0044](0044-matching-workspace.md) §2 and the separate-workspace statement in
[ADR-0050](0050-unified-batch-tuple-matching.md) establish two review surfaces.
The requested next product decision replaces that boundary, not either matching
algorithm: one existing Matching tab/review, Basic JOIN matching and an Advanced
plan in that same session. Upon acceptance this ADR supersedes those separate-UI
requirements, ADR-0044's identity-as-default-output policy for JOIN entry, and its
post-Save-only Apply restriction for JOIN-bound sessions. It does not supersede
the Mapping-only persistence contract or the safety properties of ADR-0050.

[ADR-0047](0047-matching-demo-live-boundary.md) remains authoritative: Basic uses
actual tuple retrieval; Advanced cannot claim live availability until actual
confirmed-plan row acquisition is wired. Fixtures remain explicit and non-writing.
[ADR-0049](0049-unified-suggest-right.md) and Suggest Right remain unchanged.

## Decision

1. Reuse the existing Matching workspace and session owner. Find Matches opens
   that workspace; Advanced is a plan disclosure within it, not another tool,
   review queue, decision store, or matching engine. Remove the competing Lens
   batch review after the Basic replacement is verified. Preserve in-process
   tab lifecycle, dirty-decision warnings and the no-restart-restore banner.
2. Extend the existing [proposal/candidate/session model](../../src/app/matching/types.ts:44)
   into the single authoritative review model. Producer adapters preserve exact
   nullable ordered tuple values, candidate identity, real row/tuple outputs,
   per-source candidate scores and field scores, occurrence counts, multi-origin
   provenance, alternatives, omissions, completeness and evidence revisions.
   Unknown evidence stays unknown. Do not stringify NULL, split display strings,
   normalize identity, or fabricate contextual scores from proposal state.
3. Keep one full-source-key decision ledger, separate from producer suggestions
   and temporary UI selection. No retrieval or LLM reply selects or confirms.
   Selecting then confirming stages a draft only. Later results cannot overwrite
   accepted/deferred/rejected/no-suitable decisions. Derived status is not a
   second independently mutable decision store.
4. **JOIN-bound invariant:** both Basic and Advanced use the originating ordered
   LEFT JOIN keys as Mapping inputs and corresponding ordered RIGHT JOIN keys
   as outputs. Candidate identity fields identify candidate records; they never
   implicitly replace those outputs. Advanced may change comparison fields,
   hard constraints, soft signals, reference context, normalization and ranking,
   but cannot edit the originating Mapping key/output shape or JOIN binding.
   Both retain the same validated automatic Mapping + Apply authority. JOIN
   changes invalidate the session; only explicit validated refresh may rebind,
   clearing/revalidating old evidence and never reinterpreting old decisions.
5. Basic reuses real batch tuple fuzzy retrieval, optional batch LLM prompt/parser
   and manual candidates. Advanced acquires selected real fields through Host
   and reuses existing contextual trial/retrieval and LLM algorithms. Producer
   scores are labelled with their metric; the two scorers are not equivalent.
   No scorer is reimplemented in the renderer.
6. Bulk acceptance remains an explicit counted draft operation with undo. Reuse
   the Basic 0.88 cutoff / 0.03 gap policy only with complete scored competitors,
   safe tuples, untouched pending state and no conflicting manual/LLM evidence.
   Unknown scores, incomplete coverage or unknown eligibility exclude a record.
   Advanced receives no inferred equivalent eligibility from a state label.
7. JOIN-bound writes validate IDs/revisions and materialize outputs from verified
   real candidates, then reuse existing private batch Mapping preparation,
   ApplyPlan resolution, project fold and guarded single reducer publication.
   Resolve the **session's original JOIN**, never the current Lens selection.
   Refuse incompatible maps, differing existing outputs, duplicate keys, dirty
   editor/delta state, Save in flight, frozen Check context and stale ownership.
   A failure publishes neither graph nor Mapping edits.
8. A successful reducer receipt, not preparation, acknowledges the write. Preserve
   a success summary only across its exact committed-context transition, update
   the bound JOIN index from the receipt, clear old actionable decisions and wait
   for explicit Refresh remaining review. Preserve retryable decisions on failure
   in the unchanged context. Project-file Save is separate. Local definition
   fingerprints can contain secrets and remain local; external content modified
   in place is not detected or guaranteed fresh.
9. Preserve existing Mapping-origin Save semantics independently of JOIN-bound
   atomic publication. Do not add detachment, arbitrary output rebinding,
   Mapping-only transitions, new storage/IR, global assignment, runtime LLM/fuzzy
   JOIN ON, or durable draft persistence. Detachment and rebinding are possible
   future capabilities requiring separate decisions, not implementation tasks here.

The agreed Join Lens **No match / Candidates** selector and existing Suggest Right
modal SHALL be preserved. Replacing the separate batch review does not authorize
removing or redesigning that Lens selector or the single-source modal. Advanced
remains in this same change, gated after Basic, not deferred to another change.

## Delivery gate

Basic must first demonstrate real CSV → Rust fuzzy → existing Matching review →
explicit decisions → atomic Mapping + Apply → execution → project Save → cold
Electron reopen and equivalent execution, including a bounded loopback-provider
LLM case. Only then enable Advanced real-field acquisition and contextual runs.
Historical batch or injected Matching Save tests do not prove this integration.
At final completion merge all delivered deltas into the merged capability specs;
this architecture packet deliberately leaves them in flight.
